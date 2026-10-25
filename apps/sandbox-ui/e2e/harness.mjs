// The local UI's test harness (#586): the built app (cli/internal/devui/dist)
// and a stand-in for signet dev's /api, answering from recorded fixtures, so
// Playwright and axe run against the real bundle with no simulator or
// network. Not a server for anything else: it listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', '..', 'cli', 'internal', 'devui', 'dist');
const fixtures = join(here, '..', 'src', 'fixtures');
const read = (p) => JSON.parse(readFileSync(join(fixtures, p), 'utf8'));

const spec = read('identity-registry.spec.json');
const cycle = read('cycles/counter_v2_return.json');
const fork = read('state-fork.json');
const results = { count: read('calls/read.json'), claim: read('calls/write-preview.json') };
const session = {
  contract: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
  network: { name: 'testnet', passphrase: 'Test SDF Network ; September 2015' },
  fork: { id: 'f', ledger: 5388497, time: '2026-10-25T22:07:52Z', consistent: false, drifted_entries: 1 },
  lane: 29,
  crate: { name: 'identity-registry', manifest: 'Cargo.toml' },
  build: 'target/wasm32v1-none/release/identity_registry.wasm',
  config: { file: 'signet.dev.toml', calls: 2, overrides: 0, ui_overrides: 0 },
};
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };

const port = Number(process.env.PORT ?? 4317);
createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (v, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  switch (url.pathname) {
    case '/api/session':
      return json(session);
    case '/api/spec':
      return json(spec);
    case '/api/cycles/latest':
      return json(cycle);
    case '/api/state':
      return json(
        url.searchParams.get('layer') === 'fork'
          ? fork
          : url.searchParams.get('layer') === 'override'
            ? { layer: 'override', overrides: [] }
            : { layer: 'session', entries: [], note: 'the session is rolled back to base between cycles, so it holds no writes of its own' },
      );
    case '/api/call': {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const fn = JSON.parse(body || '{}').function;
        json(results[fn] ?? results.count);
      });
      return;
    }
    case '/api/events':
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('');
      return; // held open, as signet dev holds it
  }
  const file = normalize(join(dist, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`harness on http://127.0.0.1:${port}`));
