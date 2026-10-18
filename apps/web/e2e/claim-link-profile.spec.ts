import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { apiSignIn } from './support';

/**
 * The end-to-end flow the product is judged on (#292, #623): claim a handle,
 * link a deploy wallet from the terminal with the real `signet` and `stellar`
 * binaries, let the indexer find what that wallet deployed, and see it on the
 * profile.
 *
 * It crosses four systems and nothing else in the suite covers the seams
 * between them. The existing e2e specs are smoke-only, and #208 covers
 * claim → resolve → profile; what this adds is the step that actually
 * *populates* a profile.
 *
 * ## What is real here and what is stubbed
 *
 * | Stage | How it runs |
 * |---|---|
 * | Claim | Seeded: the handle→wallet binding written as a claim lands it |
 * | Link | **Real** — `stellar keys add`, `signet link --no-browser --json`, `/link` in a browser |
 * | Indexer | **Real** — the operations and deployment workers, Horizon stubbed |
 * | Profile | **Real** — the deployed Next.js page, rendered in a browser, |
 * |         | including the "Deployed contracts" section (#455) |
 *
 * Only two things are not real, and both are deliberate:
 *
 *  - **The claim** is seeded rather than performed on-chain. A real claim needs
 *    a deployed registry and RPC; the default e2e run is hermetic on purpose.
 *    What matters downstream is the binding it produces, which is what is
 *    seeded.
 *  - **Horizon** is stubbed in the indexer subprocess, because the deploy key
 *    is a `Keypair.random()` with no history on any real network. The workers
 *    themselves are not stubbed.
 *
 * The link step drives the real `signet` binary built from `cli/` and the real
 * `stellar` CLI (#623): the test registers its deploy key with `stellar keys
 * add`, spawns `signet link --no-browser --json --url <baseURL> --source <name>`,
 * reads the approval URL from stderr, approves (or rejects) it in Chromium as
 * the handle owner, and waits for `signet` to finish proving the key via
 * `stellar tx sign`.
 *
 * ## Why it needs a database
 *
 * The stages this exercises are the database-backed ones: linking fails closed
 * without a database (#277), and the profile falls back to on-chain registry data
 * when there is none. Asserting against the fallback would be testing a
 * different flow while appearing to test this one. CI provides Postgres for
 * this spec specifically; locally:
 *
 *   pnpm db:up && pnpm db:migrate
 *   DATABASE_URL=… pnpm --filter @signet/web test:e2e
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
// `__dirname`, not `import.meta.url`: apps/web is not `"type": "module"`, so
// Playwright loads specs as CommonJS and `import.meta` is a syntax error — one
// that breaks collection for the whole directory, taking the unrelated smoke
// specs down with it.
const here = __dirname;

const SECRET_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/;
const APPROVAL_URL_PATTERN = /(https?:\/\/\S+\/link\?\S+)/;
const USER_CODE_PATTERN = /The approval page will show this code:\s*([0-9A-HJKMNP-TV-Z]{8})/;

function createCliEnv(configDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: configDir,
    STELLAR_CONFIG_HOME: path.join(configDir, 'stellar'),
    // `stellar tx sign --network-passphrase` can demand an RPC URL on CI's runner
    // ("network passphrase is used but rpc-url is missing"). Signing is offline and never
    // contacts it, so point it at an address nothing listens on.
    STELLAR_RPC_URL: process.env.STELLAR_RPC_URL ?? 'http://127.0.0.1:1',
  };
}

function addStellarIdentity(sourceName: string, secret: string, configDir: string): void {
  const stellarBin = process.env.STELLAR_E2E_BINARY ?? 'stellar';
  execFileSync(stellarBin, ['keys', 'add', sourceName, '--secret-key', '--overwrite'], {
    input: `${secret}\n`,
    env: {
      ...createCliEnv(configDir),
      STELLAR_SECRET_KEY: secret,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function spawnSignetLink(options: {
  baseURL: string;
  sourceName: string;
  configDir: string;
}) {
  const signetBin = process.env.SIGNET_E2E_BINARY ?? 'signet';
  const child = spawn(
    signetBin,
    [
      'link',
      '--no-browser',
      '--json',
      '--url',
      options.baseURL,
      '--source',
      options.sourceName,
    ],
    {
      env: createCliEnv(options.configDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let exited = false;

  const exitPromise = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        exited = true;
        exitCode = code;
        resolve({ code, stdout, stderr });
      });
    },
  );

  const approvalPromptPromise = new Promise<{ approvalUrl: string; userCode: string }>(
    (resolve, reject) => {
      const checkStderr = () => {
        const urlMatch = APPROVAL_URL_PATTERN.exec(stderr);
        const codeMatch = USER_CODE_PATTERN.exec(stderr);
        if (urlMatch?.[1] && codeMatch?.[1]) {
          resolve({ approvalUrl: urlMatch[1], userCode: codeMatch[1] });
          return true;
        }
        return false;
      };

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        checkStderr();
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (!checkStderr()) {
          reject(
            new Error(
              `signet link exited (${String(code)}) before printing approval URL.\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
        }
      });
    },
  );

  return {
    waitForApprovalPrompt: () => approvalPromptPromise,
    waitForExit: () => exitPromise,
    killIfRunning: () => {
      if (!exited && exitCode === null) {
        child.kill('SIGTERM');
      }
    },
  };
}

test.describe('claim → link → indexer → profile @db', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(
    !HAS_DB,
    'needs DATABASE_URL: this flow is the database-backed path, and the fallback path is a different flow',
  );

  test.afterAll(async () => {
    if (!HAS_DB) return;
    const { prisma } = await import('@signet/db');
    await prisma.$disconnect();
  });

  test('a linked deploy wallet ends up visible on the profile', async ({ page, baseURL }) => {
    const { prisma } = await import('@signet/db');

    // Unique per attempt, so a retry or re-run cannot collide with leftovers and
    // a failure leaves inspectable rows behind rather than being cleaned up by
    // the next attempt.
    const suffix = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const handle = `e2e${suffix}`.slice(0, 32);
    const owner = Keypair.random();
    const deployer = Keypair.random();
    const sourceName = `e2e-deploy-${suffix}`;
    // Unique per run, and a real StrKey — `StrKey.decodeContract` validates
    // the checksum, so this cannot be a padded placeholder. A fixed address
    // made Playwright's retry find the *previous* attempt's Contract row and
    // compare it against this attempt's deploy key.
    const contractAddress = StrKey.encodeContract(randomBytes(32));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signet-e2e-approve-'));
    const targetBaseUrl = baseURL ?? 'http://localhost:3100';

    // ── claim ────────────────────────────────────────────────────────────
    // The binding a claim produces: a profile, and the claiming wallet as its
    // primary. `source: 'onchain'` is what a registry-observed claim records.
    const profile = await prisma.profile.create({
      data: {
        handle,
        wallets: {
          create: { pubkey: owner.publicKey(), source: 'onchain', isPrimary: true },
        },
      },
    });

    // ── link ─────────────────────────────────────────────────────────────
    // Register the deploy key in the local stellar keystore and spawn the real
    // `signet link` binary (#623).
    addStellarIdentity(sourceName, deployer.secret(), configDir);
    const cli = spawnSignetLink({
      baseURL: targetBaseUrl,
      sourceName,
      configDir,
    });

    try {
      const { approvalUrl, userCode } = await cli.waitForApprovalPrompt();
      expect(userCode, 'the CLI prints an 8-char Crockford user code on stderr (#596)').toMatch(
        /^[0-9A-HJKMNP-TV-Z]{8}$/,
      );
      const parsedApprovalUrl = new URL(approvalUrl);
      expect(parsedApprovalUrl.pathname).toBe('/link');
      expect(parsedApprovalUrl.searchParams.get('user_code')).toBe(userCode);

      // The browser half: sign in as the handle's owner and visit the exact
      // approval URL `signet link` printed to stderr.
      await apiSignIn(page, owner);
      await page.goto(approvalUrl);

      // Assert the page *shape* before its contents. /link has several refusal
      // states (no session, unknown or expired code, no database, no handle) and
      // they all render a heading instead of the approval form — so a missing
      // key below would otherwise report only "element not found" and say
      // nothing about which of them happened.
      const shown = await page.locator('body').innerText();
      expect(shown, 'the /link page should show the approval form').toContain('Approve this link');

      await expect(page.getByText(deployer.publicKey())).toBeVisible();
      await expect(page.getByText(`@${handle}`)).toBeVisible();
      // The comparison step (#596): the page shows the same code the terminal
      // printed, so the developer can tell this is their own link.
      await expect(page.getByText(userCode)).toBeVisible();
      await page.getByRole('button', { name: /approve/i }).click();
      await expect(page.getByText(/return to your terminal/i)).toBeVisible();

      const { code, stdout, stderr } = await cli.waitForExit();
      expect(code, `signet link failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      expect(stdout, 'stdout must never contain secret key material').not.toMatch(
        SECRET_KEY_PATTERN,
      );
      expect(stderr, 'stderr must never contain secret key material').not.toMatch(
        SECRET_KEY_PATTERN,
      );

      const stdoutLines = stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      expect(
        stdoutLines,
        `--json must emit exactly one JSON object on stdout; got:\n${stdout}`,
      ).toHaveLength(1);
      const completedJson = JSON.parse(stdoutLines[0] ?? '') as {
        handle: string;
        publicKey: string;
        network: string;
        status: string;
        indexingPending: boolean;
      };
      expect(completedJson).toEqual({
        handle,
        publicKey: deployer.publicKey(),
        network: 'testnet',
        status: 'linked',
        indexingPending: true,
      });
    } finally {
      cli.killIfRunning();
      fs.rmSync(configDir, { recursive: true, force: true });
    }

    const linked = await prisma.wallet.findUnique({
      where: { pubkey: deployer.publicKey() },
    });
    expect(linked?.profileId, 'the deploy wallet is bound to the claimed profile').toBe(profile.id);
    expect(linked?.source, 'and recorded as a CLI link, not a curated one').toBe('cli');
    expect(linked?.indexRequestedAt, 'indexer was asked to scan this wallet').not.toBeNull();

    // ── indexer ──────────────────────────────────────────────────────────
    // The real workers, one tick, against the real database.
    const output = execFileSync(
      'node',
      [
        '--import',
        'tsx',
        // `.mts` so it is unambiguously ESM: it uses top-level await, and the
        // nearest package.json (apps/web) is not a module, so a plain `.ts`
        // would be loaded as CommonJS and fail.
        path.join(here, 'indexer-tick.mts'),
        deployer.publicKey(),
        contractAddress,
      ],
      { cwd: path.resolve(here, '../../indexer'), encoding: 'utf8' },
    );
    expect(output, 'the indexer tick should report success').toContain('"ok":true');

    // The deployment worker recorded what the wallet deployed…
    const contract = await prisma.contract.findUnique({ where: { address: contractAddress } });
    expect(contract?.deployerPubkey, `indexer said: ${output}`).toBe(deployer.publicKey());

    // …and the operations worker recorded the activity the profile reads.
    // Checked in the database *before* the page, so a failure says which half
    // broke: no rows means the link or the worker did; rows but no render
    // means the read path did.
    const opCount = await prisma.operation.count({ where: { walletId: linked!.id } });
    expect(opCount, `operations worker wrote nothing; indexer said: ${output}`).toBeGreaterThan(0);

    // ── profile ──────────────────────────────────────────────────────────
    // …the operations worker put the activity where the profile reads it,
    // and the deployment worker's Contract row is listed with a link to its
    // page (#455). This is the assertion that would catch a break in any seam
    // above: the page renders operations and contracts, so an empty list here
    // means the chain broke somewhere between the link and the read, whatever
    // else passed.
    await page.goto(`/p/${handle}`);
    const profileText = await page.locator('body').innerText();
    // `invoke_contract`, not the raw function name: `resolveFunction` in
    // operations-list.tsx deliberately skips anything starting with
    // "HostFunction" and falls back to this, so a create-contract operation
    // renders as `invoke_contract`. Asserting the raw name would be asserting
    // against something the page never shows.
    expect(profileText, 'the profile should render the deployment').toContain('invoke_contract');

    // The recorded contract is listed in "Deployed contracts" and the link
    // resolves to its page (200): the row hrefs `/p/{handle}/contract/{address}`,
    // which the attribution gate lets through because the indexer recorded
    // this handle's wallet as the deployer.
    const contractLink = page.locator(`a[href="/p/${handle}/contract/${contractAddress}"]`);
    await expect(contractLink, 'the profile should list the recorded contract').toBeVisible();
    const [contractResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/p/${handle}/contract/${contractAddress}`) &&
          r.request().method() === 'GET',
      ),
      contractLink.click(),
    ]);
    expect(contractResponse.status(), 'the contract page should resolve to 200').toBe(200);
  });

  test('a rejected link exits 8 and leaves no Wallet row', async ({ page, baseURL }) => {
    const { prisma } = await import('@signet/db');

    const suffix = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const handle = `e2er${suffix}`.slice(0, 32);
    const owner = Keypair.random();
    const deployer = Keypair.random();
    const sourceName = `e2e-reject-${suffix}`;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signet-e2e-reject-'));
    const targetBaseUrl = baseURL ?? 'http://localhost:3100';

    await prisma.profile.create({
      data: {
        handle,
        wallets: {
          create: { pubkey: owner.publicKey(), source: 'onchain', isPrimary: true },
        },
      },
    });

    addStellarIdentity(sourceName, deployer.secret(), configDir);
    const cli = spawnSignetLink({
      baseURL: targetBaseUrl,
      sourceName,
      configDir,
    });

    try {
      const { approvalUrl, userCode } = await cli.waitForApprovalPrompt();

      await apiSignIn(page, owner);
      await page.goto(approvalUrl);

      const shown = await page.locator('body').innerText();
      expect(shown, 'the /link page should show the approval form').toContain('Approve this link');
      await expect(page.getByText(deployer.publicKey())).toBeVisible();
      await expect(page.getByText(`@${handle}`)).toBeVisible();
      await expect(page.getByText(userCode)).toBeVisible();

      await page.getByRole('button', { name: /reject/i }).click();
      await expect(page.getByText(/rejected\. nothing was linked/i)).toBeVisible();

      const { code, stdout, stderr } = await cli.waitForExit();
      expect(
        code,
        `signet link should exit 8 (ApprovalRejected).\nstdout: ${stdout}\nstderr: ${stderr}`,
      ).toBe(8);
      expect(stdout.trim(), '--json must write nothing to stdout on error').toBe('');
      expect(stdout, 'stdout must never contain secret key material').not.toMatch(
        SECRET_KEY_PATTERN,
      );
      expect(stderr, 'stderr must never contain secret key material').not.toMatch(
        SECRET_KEY_PATTERN,
      );
    } finally {
      cli.killIfRunning();
      fs.rmSync(configDir, { recursive: true, force: true });
    }

    const rejectedWallet = await prisma.wallet.findUnique({
      where: { pubkey: deployer.publicKey() },
    });
    expect(rejectedWallet, 'rejecting the link must not create a Wallet row').toBeNull();
  });
});

