import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { apiSignIn } from './support';

/**
 * The end-to-end flow the product is judged on (#292): claim a handle, link a
 * deploy wallet from the terminal, let the indexer find what that wallet
 * deployed, and see it on the profile.
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
 * | Link | **Real** — `pair/start`, the `/link` page in a browser, `pair/complete` |
 * | Indexer | **Real** — the operations and deployment workers, Horizon stubbed |
 * | Profile | **Real** — the deployed Next.js page, rendered in a browser |
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
 * The link step used to be stubbed too — this spec was written before
 * `signet link` existed. It does now (#393), so the CLI's half is performed
 * here exactly as the CLI performs it: mint a pairing declaring the deploy
 * key, approve it in a browser, then prove the key with a signed SEP-10
 * challenge. Only the loopback listener is absent, which is what "loopback
 * stubbed" in the issue means — and the polling path exists precisely because
 * that listener cannot always be reached.
 *
 * ## Why it needs a database
 *
 * The stages this exercises are the database-backed ones: linking fails closed
 * without a database (#277), and the profile falls back to chain/curated data
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

test.describe('claim → link → indexer → profile', () => {
  test.skip(
    !HAS_DB,
    'needs DATABASE_URL: this flow is the database-backed path, and the fallback path is a different flow',
  );

  // Unique per run, so a re-run cannot collide with its own leftovers and a
  // failure leaves inspectable rows behind rather than being cleaned up by the
  // next attempt.
  const suffix = Date.now().toString(36);
  const handle = `e2e${suffix}`.slice(0, 32);
  const owner = Keypair.random();
  const deployer = Keypair.random();
  // A real contract StrKey — `StrKey.decodeContract` validates the checksum,
  // so this cannot be a padded placeholder. Same fixture the deployment
  // worker's unit tests use.
  const contractAddress = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

  test('a linked deploy wallet ends up visible on the profile', async ({ page }) => {
    const { prisma } = await import('@signet/db');

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
    // The CLI's first call: mint a pairing, declaring the deploy account so
    // the browser can show which key it is approving.
    const started = await page.request.post('/api/cli/pair/start', {
      data: { publicKey: deployer.publicKey() },
    });
    expect(started.ok(), 'pair/start should mint a pairing').toBeTruthy();
    const { state, pollToken } = (await started.json()) as {
      state: string;
      pollToken: string;
    };
    expect(pollToken, 'the CLI gets a poll token distinct from the pairing code').not.toBe(state);

    // The browser half: sign in as the handle's owner and approve. This is the
    // proof that the person approving owns the handle.
    await apiSignIn(page, owner);
    await page.goto(`/link?code=${state}`);

    // Assert the page *shape* before its contents. /link has several refusal
    // states (no session, unknown or expired code, no database, no handle) and
    // they all render a heading instead of the approval form — so a missing
    // key below would otherwise report only "element not found" and say
    // nothing about which of them happened.
    const shown = await page.locator('body').innerText();
    expect(shown, 'the /link page should show the approval form').toContain('Approve this link');

    await expect(page.getByText(deployer.publicKey())).toBeVisible();
    await expect(page.getByText(`@${handle}`)).toBeVisible();
    await page.getByRole('button', { name: /approve/i }).click();
    await expect(page.getByText(/return to your terminal/i)).toBeVisible();

    // The CLI now sees the approval. Polling is the path that always works —
    // the loopback callback is the one this spec does not run.
    const polled = await page.request.get(
      `/api/cli/pair/status?pollToken=${encodeURIComponent(pollToken)}`,
    );
    expect(polled.ok()).toBeTruthy();
    expect((await polled.json()).status).toBe('approved');

    // The CLI's second proof: a SEP-10 challenge signed by the deploy key.
    const challenge = await page.request.get(`/api/auth/sep10?account=${deployer.publicKey()}`);
    expect(challenge.ok()).toBeTruthy();
    const { transaction, network_passphrase } = (await challenge.json()) as {
      transaction: string;
      network_passphrase: string;
    };
    const signed = TransactionBuilder.fromXDR(transaction, network_passphrase);
    signed.sign(deployer);

    const completed = await page.request.post('/api/cli/pair/complete', {
      data: { state, transaction: signed.toEnvelope().toXDR('base64') },
    });
    expect(completed.ok(), 'pair/complete should attach the wallet').toBeTruthy();
    expect((await completed.json()).handle).toBe(handle);

    const linked = await prisma.wallet.findUnique({
      where: { pubkey: deployer.publicKey() },
    });
    expect(linked?.profileId, 'the deploy wallet is bound to the claimed profile').toBe(profile.id);
    expect(linked?.source, 'and recorded as a CLI link, not a curated one').toBe('cli');

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
    expect(contract?.deployerPubkey).toBe(deployer.publicKey());

    // ── profile ──────────────────────────────────────────────────────────
    // …and the operations worker put the activity where the profile reads it.
    // This is the assertion that would catch a break in any seam above: the
    // page renders operations, so an empty list here means the chain broke
    // somewhere between the link and the read, whatever else passed.
    await page.goto(`/p/${handle}`);
    await expect(page.getByText(/invoke_host_function|CreateContract/i).first()).toBeVisible();

    const opCount = await prisma.operation.count({ where: { walletId: linked!.id } });
    expect(opCount, 'the profile is populated, not silently empty').toBeGreaterThan(0);

    await prisma.$disconnect();
  });
});
