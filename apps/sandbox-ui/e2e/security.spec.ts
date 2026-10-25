import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The local UI's protections (#576) from a real browser (#587), against the
 * real server code: cli/internal/devui/harness serves the same locked-down
 * server, embedded app and API handler as `signet dev --ui`, over a stub
 * session. (`signet dev` itself needs a contract crate, cargo, the stellar
 * CLI and a live RPC to fork, so it is not what CI launches.) Needs Go, and
 * the app built into cli/internal/devui/dist first.
 */
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cli');

let harness: ChildProcess;
let base = '';
let token = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  info.setTimeout(240_000);
  harness = spawn('go', ['run', './internal/devui/harness'], { cwd: cli, stdio: ['pipe', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    harness.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n')[0];
      if (out.includes('\n') && line) resolve(line.trim());
    });
    harness.on('exit', (code) => reject(new Error(`the harness exited (${code})`)));
  });
  [base, token] = url.split('/#t=') as [string, string];
});

test.afterAll(() => {
  harness?.stdin?.end();
  harness?.kill();
});

/** One raw HTTP request with exactly these headers (no browser rewriting Host or Origin). */
function raw(path: string, headers: Record<string, string>): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const overrides = async () => {
  const res = await fetch(`${base}/api/state?layer=override`, { headers: { Authorization: `Bearer ${token}` } });
  return ((await res.json()) as { overrides: unknown[] }).overrides;
};

test('a page on another origin can neither fetch nor form-POST to the UI, even holding the token', async ({ page }) => {
  // The attacker's page, served from a second local server on another port.
  const evil: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>waiting</title>
      <form method="POST" action="${base}/api/overrides" enctype="text/plain">
        <input name='{"durability":"instance","key":"symbol:\\"pwned\\"","value":"u32:1","pad":"' value='"}'>
      </form>
      <script>
        fetch(${JSON.stringify(`${base}/api/overrides`)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${token}' },
          body: JSON.stringify({ durability: 'instance', key: 'symbol:"pwned"', value: 'u32:1' }),
        }).then((r) => { document.title = 'fetch answered ' + r.status; }, () => { document.title = 'fetch blocked'; });
      </script>`);
  });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
  const port = (evil.address() as { port: number }).port;
  try {
    await page.goto(`http://localhost:${port}/`);
    await expect(page).toHaveTitle('fetch blocked');

    const posted = page.waitForResponse((r) => r.url() === `${base}/api/overrides`);
    await page.locator('form').evaluate((f: HTMLFormElement) => f.submit());
    expect((await posted).status()).toBe(403);

    expect(await overrides()).toEqual([]);
  } finally {
    evil.close();
  }
});

test('a request naming another host (DNS rebinding) is refused', async () => {
  const { port } = new URL(base);
  expect(await raw('/api/session', { Host: `evil.example:${port}`, Authorization: `Bearer ${token}` })).toBe(403);
  expect(await raw('/', { Host: `evil.example:${port}` })).toBe(403);
  // The same request with the server's own host is answered.
  expect(await raw('/api/session', { Host: new URL(base).host, Authorization: `Bearer ${token}` })).toBe(200);
});

test('without the token the page says so and the API answers 401', async ({ page }) => {
  await page.goto(`${base}/`);
  await expect(page.getByRole('heading', { name: 'This page needs the link signet dev printed' })).toBeVisible();
  expect(await raw('/api/session', { Host: new URL(base).host })).toBe(401);
});

test("the server is not reachable on the machine's other addresses", async () => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  test.skip(!address, 'this machine has no non-loopback IPv4 address');
  const { port } = new URL(base);
  const reached = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: address!, port: Number(port), timeout: 3000 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
  expect(reached, `127.0.0.1:${port} must not answer on ${address}`).toBe(false);
});
