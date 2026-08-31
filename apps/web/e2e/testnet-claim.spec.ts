import { test, expect } from '@playwright/test';
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  Account,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * The sequence a real user performs, against the real testnet registry:
 * claim a handle on-chain, resolve it, then load /p/{handle} and see the
 * claiming wallet on the page. Every piece is unit-tested elsewhere; this is
 * the seam test — the bugs in this backlog (unconsumed events, cursor stalls,
 * directory windows) all lived between the pieces, where each unit suite was
 * green.
 *
 * Opt-in: it funds an account via friendbot and submits a real transaction to
 * the shared testnet registry, so it must never run implicitly in CI. Enable
 * with SIGNET_TESTNET_E2E=1 — playwright.config.ts then also hands the
 * registry env to the web server, whose chain fallback is what turns the
 * on-chain claim into a rendered profile (no DB, no indexer involved).
 *
 * Cost & hygiene: one friendbot funding, one claim (~0.62 XLM testnet), one
 * best-effort release at the end so the shared registry isn't littered with
 * e2e handles. The handle is unique per run, which also defeats the profile
 * page's 60s ISR cache — the first request for it can't be stale.
 */

const RUN_TESTNET = !!process.env.SIGNET_TESTNET_E2E;

const CONTRACT_ID =
  process.env.REGISTRY_CONTRACT_ID ?? 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

function handleArg(h: string): xdr.ScVal {
  return nativeToScVal(h, { type: 'string' });
}

/** Build → simulate → sign → submit → poll, per docs/REGISTRY_INTEGRATION.md §6. */
async function invoke(
  server: rpc.Server,
  contract: Contract,
  kp: Keypair,
  method: string,
  ...args: xdr.ScVal[]
): Promise<void> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`${method} send failed: ${JSON.stringify(sent.errorResult)}`);
  let result = await server.getTransaction(sent.hash);
  for (let poll = 0; result.status === 'NOT_FOUND' && poll < 60; poll += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    result = await server.getTransaction(sent.hash);
  }
  if (result.status !== 'SUCCESS') throw new Error(`${method} failed: ${result.status}`);
}

/** Read-only registry call via simulation (free, unsigned). */
async function read(server: rpc.Server, contract: Contract, method: string, ...args: xdr.ScVal[]) {
  const source = new Account('GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD', '0');
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!sim.result) throw new Error(`${method}: simulation returned no result`);
  return scValToNative(sim.result.retval);
}

test.describe('claim → resolve → profile (live testnet)', () => {
  test.skip(!RUN_TESTNET, 'opt-in: set SIGNET_TESTNET_E2E=1 (funds and writes on testnet)');
  // Friendbot + prepare + submit + ledger close + page render, serially.
  test.setTimeout(240_000);

  test('a freshly claimed handle renders its claiming wallet on /p/{handle}', async ({ page }) => {
    // Unique per ATTEMPT, not per run: a retry after a claim that stuck (e.g.
    // the release in the finally block failed) must not re-claim the same
    // name. base36 millis + entropy stays inside the 32-char handle limit.
    const HANDLE = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const kp = Keypair.random();
    const wallet = kp.publicKey();
    const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
    const contract = new Contract(CONTRACT_ID);

    // Fund the claiming account. Friendbot occasionally hiccups — as an HTTP
    // error or as a network-level rejection — so both shapes get the one retry.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const res = await fetch(`https://friendbot.stellar.org/?addr=${wallet}`);
        if (res.ok) break;
        throw new Error(`friendbot failed: HTTP ${res.status}`);
      } catch (err) {
        if (attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    try {
      // CLAIM — signed by the claiming wallet; the signature is the ownership proof.
      await invoke(server, contract, kp, 'claim', handleArg(HANDLE), new Address(wallet).toScVal());

      // RESOLVE — the registry answers with the claiming wallet.
      const resolved = await read(server, contract, 'resolve', handleArg(HANDLE));
      expect(resolved).toBe(wallet);

      // PROFILE — the page the world sees. The web server has no DB row and no
      // indexer sync for this handle; only its live chain fallback can answer,
      // and the wallet it renders must be the claiming wallet.
      await page.goto(`/p/${HANDLE}`);
      await expect(page.getByText(`@${HANDLE}`)).toBeVisible();
      // The full address is in the DOM as the copyable value's title.
      await expect(page.locator(`[title="${wallet}"]`).first()).toBeVisible();
      // An on-chain binding must not be framed as curated demo data.
      await expect(page.getByText(/Synthetic data · Testnet demo/i)).toHaveCount(0);
    } finally {
      // Leave the shared registry as we found it (best effort — the assertion
      // above has already settled the verdict).
      try {
        await invoke(server, contract, kp, 'release', handleArg(HANDLE));
      } catch {
        /* an orphaned e2e handle is unfortunate, not a failure */
      }
    }
  });
});
