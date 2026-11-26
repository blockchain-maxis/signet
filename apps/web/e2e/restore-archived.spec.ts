import { test, expect, type Page, type Route } from '@playwright/test';
import {
  Keypair,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { stubWallet } from './support';
import { ARCHIVED_HANDLE, MOCK_REGISTRY_ID } from './fixtures/docs-failures';

/**
 * Restoring an archived binding from the profile page (#897).
 *
 * Tagged `@db` so it runs in `e2e-linked`, where the server's chain fallback
 * reads the mock registry and renders `ARCHIVED_HANDLE` as archived (#896).
 *
 * The restore itself runs in the browser, so its RPC traffic is answered here,
 * per page, rather than by the shared mock: the account lookup, the `resolve`
 * simulation that names what to restore, and the submission. The submitted
 * envelope is checked in Node, so "the wallet was asked to sign" means a real
 * signature by the stubbed wallet's key over a `restoreFootprint`.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const PASSPHRASE = Networks.TESTNET;
const TX_HASH = 'ab'.repeat(32);

function rpcResult(route: Route, id: unknown, result: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
}

/** The ledger key of `kp`'s account. */
function accountKey(kp: Keypair): string {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrPublicKey() })).toXDR(
    'base64',
  );
}

/** A funded account entry for `kp`, as `getLedgerEntries` returns it. */
function accountEntry(kp: Keypair): string {
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: kp.xdrPublicKey(),
      balance: xdr.Int64.fromString('100000000'),
      seqNum: xdr.Int64.fromString('4096'),
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: '',
      thresholds: Buffer.from([1, 0, 0, 0]),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    }),
  ).toXDR('base64');
}

/**
 * Answers the browser's Soroban RPC calls and records what was submitted.
 * Any cross-origin JSON-RPC POST is the client's RPC, whichever URL the build
 * baked in.
 */
async function mockClientRpc(page: Page, kp: Keypair, appOrigin: string): Promise<Transaction[]> {
  const submitted: Transaction[] = [];
  const data = new SorobanDataBuilder().build().toXDR('base64');
  await page.route(
    (url) => url.origin !== appOrigin,
    async (route) => {
      const req = route.request();
      let body: { id?: unknown; method?: string; params?: { transaction?: string } } = {};
      try {
        body = req.method() === 'POST' ? JSON.parse(req.postData() ?? '{}') : {};
      } catch {
        /* not JSON-RPC */
      }
      switch (body.method) {
        case 'getLedgerEntries':
          return rpcResult(route, body.id, {
            entries: [{ key: accountKey(kp), xdr: accountEntry(kp), lastModifiedLedgerSeq: 1 }],
            latestLedger: 2,
          });
        case 'simulateTransaction':
          return rpcResult(route, body.id, {
            transactionData: data,
            minResourceFee: '100',
            results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
            restorePreamble: { transactionData: data, minResourceFee: '2500' },
            latestLedger: 2,
          });
        case 'sendTransaction':
          submitted.push(
            TransactionBuilder.fromXDR(body.params?.transaction ?? '', PASSPHRASE) as Transaction,
          );
          return rpcResult(route, body.id, {
            status: 'PENDING',
            hash: TX_HASH,
            latestLedger: 2,
            latestLedgerCloseTime: '0',
          });
        default:
          return route.fallback();
      }
    },
  );
  return submitted;
}

test.describe('restore an archived binding @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: the mock registry only runs with the fixture database');
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the wallet signs a restoreFootprint and the result is announced', async ({
    page,
    baseURL,
  }) => {
    const kp = Keypair.random();
    await stubWallet(page, kp);
    const submitted = await mockClientRpc(page, kp, new URL(baseURL!).origin);

    // The registry confirms the restore on the first poll.
    let polls = 0;
    await page.route(`**/api/v1/resolve/${ARCHIVED_HANDLE}`, (route) => {
      polls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            handle: ARCHIVED_HANDLE,
            wallet: kp.publicKey(),
            network: 'testnet',
            registryContract: MOCK_REGISTRY_ID,
          },
        }),
      });
    });

    await page.goto(`/p/${ARCHIVED_HANDLE}`);
    await expect(page.getByText('Archived on-chain · Identity Registry')).toBeVisible();
    const button = page.getByRole('button', { name: 'Restore binding' });
    await expect(button).toBeVisible();

    // Keyboard-reachable: Tab lands on it, Enter presses it.
    let focused = false;
    for (let i = 0; i < 60 && !focused; i++) {
      await page.keyboard.press('Tab');
      focused = await button.evaluate((el) => el === document.activeElement);
    }
    expect(focused, 'the restore button is in the tab order').toBe(true);
    await page.keyboard.press('Enter');

    const status = page.getByRole('status').filter({ hasText: /Binding restored/ });
    await expect(status).toBeVisible({ timeout: 20_000 });
    await expect(
      status.getByRole('link', { name: /View transaction on Stellar Expert/ }),
    ).toHaveAttribute('href', new RegExp(`/tx/${TX_HASH}$`));

    // The wallet really signed what was submitted: one restore, by its key.
    expect(submitted).toHaveLength(1);
    const tx = submitted[0]!;
    expect(tx.source).toBe(kp.publicKey());
    expect(tx.operations.map((op) => op.type)).toEqual(['restoreFootprint']);
    expect(tx.fee).toBe(String(100 + 2500));
    expect(tx.signatures).toHaveLength(1);
    expect(kp.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
    expect(polls).toBeGreaterThan(0);
  });
});
