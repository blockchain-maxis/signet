import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  startPairing,
  submitPairingProof,
  pairingProofMessage,
  getPairingForApproval,
  approvePairing,
  pollPairing,
  completePairingManually,
  CliPairingError,
  type CliPairingRecord,
  type CliPairingStore,
  type ProfileLookupStore,
} from './cli-pairing.ts';
import type { LinkWalletStore } from './account.ts';

/** In-memory CliPairingStore — mirrors the fakeLinkStore pattern in account.test.ts. */
function fakePairingStore(): { store: CliPairingStore; rows: Map<string, CliPairingRecord> } {
  const rows = new Map<string, CliPairingRecord>();
  let seq = 0;
  const store: CliPairingStore = {
    create: async ({ data }) => {
      const row: CliPairingRecord = {
        id: `row-${++seq}`,
        pairingCode: data.pairingCode,
        pollToken: data.pollToken,
        nonce: data.nonce,
        completionCode: null,
        publicKey: data.publicKey,
        network: data.network,
        proven: data.proven,
        status: data.status,
        profileId: null,
        expiresAt: data.expiresAt,
      };
      rows.set(row.id, row);
      return row;
    },
    findFirst: async ({ where }) => {
      for (const row of rows.values()) {
        if (where.pairingCode !== undefined && row.pairingCode === where.pairingCode) return row;
        if (where.pollToken !== undefined && row.pollToken === where.pollToken) return row;
      }
      return null;
    },
    update: async ({ where, data }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('no such row');
      const updated = { ...row, ...data };
      rows.set(where.id, updated);
      return updated;
    },
    updateMany: async ({ where, data }) => {
      const row = rows.get(where.id);
      if (!row || row.status !== where.status) return { count: 0 };
      rows.set(where.id, { ...row, ...data });
      return { count: 1 };
    },
  };
  return { store, rows };
}

function fakeWalletStore(): { store: LinkWalletStore } {
  const rows = new Map<string, { pubkey: string; profileId: string; isPrimary: boolean; source: string; attestedAt: Date }>();
  const store: LinkWalletStore = {
    wallet: {
      findUnique: async ({ where: { pubkey } }) => rows.get(pubkey) ?? null,
      create: async ({ data }) => {
        const row = { ...data };
        rows.set(data.pubkey, row);
        return row;
      },
      update: async ({ where: { pubkey }, data }) => {
        const row = rows.get(pubkey);
        if (!row) throw new Error('no such row');
        const updated = { ...row, ...data };
        rows.set(pubkey, updated);
        return updated;
      },
    },
  };
  return { store };
}

function fakeProfileLookup(pubkeyToProfile: Record<string, string>): ProfileLookupStore {
  return {
    wallet: {
      findUnique: async ({ where: { pubkey } }) => {
        const profileId = pubkeyToProfile[pubkey];
        return profileId ? { profileId } : null;
      },
    },
  };
}

const KEYPAIR = Keypair.random();
const PUBLIC_KEY = KEYPAIR.publicKey();
const OWNER_ADDRESS = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';

function sign(message: string): string {
  return KEYPAIR.sign(Buffer.from(message, 'utf8')).toString('base64');
}

async function provenSession(store: CliPairingStore) {
  const started = await startPairing(PUBLIC_KEY, 'testnet', store);
  const signature = sign(pairingProofMessage(started.pairingCode, started.nonce));
  await submitPairingProof(started.pollToken, signature, store);
  return started;
}

// ─── startPairing / submitPairingProof ──────────────────────────────────────

test('startPairing rejects a malformed public key', async () => {
  const { store } = fakePairingStore();
  await assert.rejects(() => startPairing('not-a-key', 'testnet', store), CliPairingError);
});

test('submitPairingProof accepts a correctly signed nonce', async () => {
  const { store } = fakePairingStore();
  const started = await startPairing(PUBLIC_KEY, 'testnet', store);
  const signature = sign(pairingProofMessage(started.pairingCode, started.nonce));

  await submitPairingProof(started.pollToken, signature, store);

  const view = await getPairingForApproval(started.pairingCode, store);
  assert.equal(view?.status, 'pending', 'proven and awaiting approval');
});

test('submitPairingProof rejects a signature from the wrong key', async () => {
  const { store } = fakePairingStore();
  const started = await startPairing(PUBLIC_KEY, 'testnet', store);
  const wrongSignature = Keypair.random()
    .sign(Buffer.from(pairingProofMessage(started.pairingCode, started.nonce)))
    .toString('base64');

  await assert.rejects(
    () => submitPairingProof(started.pollToken, wrongSignature, store),
    (err: unknown) => err instanceof CliPairingError && err.code === 'bad-signature',
  );
});

test('getPairingForApproval reports waiting-for-cli before the proof lands', async () => {
  const { store } = fakePairingStore();
  const started = await startPairing(PUBLIC_KEY, 'testnet', store);

  const view = await getPairingForApproval(started.pairingCode, store);
  assert.equal(view?.status, 'waiting-for-cli');
});

// ─── approvePairing ──────────────────────────────────────────────────────────

test('approvePairing rejects approval before the CLI has proven its key', async () => {
  const { store } = fakePairingStore();
  const started = await startPairing(PUBLIC_KEY, 'testnet', store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({ [OWNER_ADDRESS]: 'profile-1' });

  await assert.rejects(
    () => approvePairing(started.pairingCode, OWNER_ADDRESS, store, walletStore, profiles),
    (err: unknown) => err instanceof CliPairingError && err.code === 'unproven',
  );
});

test('approvePairing links the wallet and mints a completion code', async () => {
  const { store } = fakePairingStore();
  const started = await provenSession(store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({ [OWNER_ADDRESS]: 'profile-1' });

  const { completionCode } = await approvePairing(started.pairingCode, OWNER_ADDRESS, store, walletStore, profiles);

  assert.ok(completionCode.length > 0);
  const linked = await walletStore.wallet.findUnique({ where: { pubkey: PUBLIC_KEY } });
  assert.equal(linked?.profileId, 'profile-1');
  assert.equal(linked?.source, 'cli');
});

test('approvePairing refuses a caller with no claimed profile', async () => {
  const { store } = fakePairingStore();
  const started = await provenSession(store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({}); // OWNER_ADDRESS has no profile

  await assert.rejects(
    () => approvePairing(started.pairingCode, OWNER_ADDRESS, store, walletStore, profiles),
    (err: unknown) => err instanceof CliPairingError && err.code === 'no-profile',
  );
});

test('approvePairing cannot be replayed against an already-approved session', async () => {
  const { store } = fakePairingStore();
  const started = await provenSession(store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({ [OWNER_ADDRESS]: 'profile-1' });

  await approvePairing(started.pairingCode, OWNER_ADDRESS, store, walletStore, profiles);

  await assert.rejects(
    () => approvePairing(started.pairingCode, OWNER_ADDRESS, store, walletStore, profiles),
    (err: unknown) => err instanceof CliPairingError && err.code === 'invalid-state',
  );
});

// ─── pollPairing / completePairingManually — the two fallback completion paths ──

test('pollPairing reports pending before approval, then the result exactly once', async () => {
  const { store } = fakePairingStore();
  const started = await provenSession(store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({ [OWNER_ADDRESS]: 'profile-1' });

  assert.deepEqual(await pollPairing(started.pollToken, store), { state: 'pending' });

  await approvePairing(started.pairingCode, OWNER_ADDRESS, store, walletStore, profiles);

  const first = await pollPairing(started.pollToken, store);
  assert.equal(first.state, 'approved');
  if (first.state === 'approved') {
    assert.equal(first.result.publicKey, PUBLIC_KEY);
    assert.equal(first.result.profileId, 'profile-1');
  }

  const second = await pollPairing(started.pollToken, store);
  assert.equal(second.state, 'not-found', 'a second poll cannot re-claim an already-consumed session');
});

test('completePairingManually accepts the browser-shown code exactly once', async () => {
  const { store } = fakePairingStore();
  const started = await provenSession(store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({ [OWNER_ADDRESS]: 'profile-1' });
  const { completionCode } = await approvePairing(
    started.pairingCode,
    OWNER_ADDRESS,
    store,
    walletStore,
    profiles,
  );

  const first = await completePairingManually(started.pairingCode, completionCode, store);
  assert.equal(first.state, 'approved');

  const second = await completePairingManually(started.pairingCode, completionCode, store);
  assert.equal(second.state, 'not-found', 'single-use: the same code cannot complete twice');
});

test('completePairingManually rejects a wrong code without leaking session state', async () => {
  const { store } = fakePairingStore();
  const started = await provenSession(store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({ [OWNER_ADDRESS]: 'profile-1' });
  await approvePairing(started.pairingCode, OWNER_ADDRESS, store, walletStore, profiles);

  const outcome = await completePairingManually(started.pairingCode, 'WRONG-CODE', store);
  assert.equal(outcome.state, 'not-found');
});

test('polling and the manual code race for the same completion — only one wins', async () => {
  const { store } = fakePairingStore();
  const started = await provenSession(store);
  const { store: walletStore } = fakeWalletStore();
  const profiles = fakeProfileLookup({ [OWNER_ADDRESS]: 'profile-1' });
  const { completionCode } = await approvePairing(
    started.pairingCode,
    OWNER_ADDRESS,
    store,
    walletStore,
    profiles,
  );

  const [byPoll, byCode] = await Promise.all([
    pollPairing(started.pollToken, store),
    completePairingManually(started.pairingCode, completionCode, store),
  ]);

  const winners = [byPoll, byCode].filter((o) => o.state === 'approved');
  assert.equal(winners.length, 1, 'the two fallback paths share one atomic consume — exactly one succeeds');
});

test('an expired session is rejected by every entry point', async () => {
  const { store, rows } = fakePairingStore();
  const started = await startPairing(PUBLIC_KEY, 'testnet', store);
  for (const row of rows.values()) row.expiresAt = new Date(Date.now() - 1000);

  await assert.rejects(
    () => submitPairingProof(started.pollToken, sign('anything'), store),
    (err: unknown) => err instanceof CliPairingError && err.code === 'expired',
  );
  const view = await getPairingForApproval(started.pairingCode, store);
  assert.equal(view?.status, 'expired');
  assert.deepEqual(await pollPairing(started.pollToken, store), { state: 'expired' });
});
