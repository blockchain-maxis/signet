import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  decodeEvent,
  applyAttestation,
  type AttestationStore,
} from './attestation.ts';

function topics(kind: string, handle: string): xdr.ScVal[] {
  return [nativeToScVal(kind, { type: 'symbol' }), nativeToScVal(handle, { type: 'string' })];
}
const walletVal = (pubkey: string): xdr.ScVal => new Address(pubkey).toScVal();

test('decodeEvent decodes a claimed event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('claimed', 'aquawolf'), walletVal(pk)), {
    kind: 'claimed',
    handle: 'aquawolf',
    wallet: pk,
  });
});

test('decodeEvent decodes a released event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('released', 'aquawolf'), walletVal(pk)), {
    kind: 'released',
    handle: 'aquawolf',
    wallet: pk,
  });
});

test('decodeEvent decodes a revoked event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('revoked', 'aquawolf'), walletVal(pk)), {
    kind: 'revoked',
    handle: 'aquawolf',
    wallet: pk,
  });
});

test('decodeEvent ignores unrelated or malformed events', () => {
  const pk = Keypair.random().publicKey();
  assert.equal(decodeEvent(topics('transfer', 'x'), walletVal(pk)), null);
  assert.equal(decodeEvent([nativeToScVal('claimed', { type: 'symbol' })], walletVal(pk)), null);
});

function recordingStore(): { store: AttestationStore; calls: any[] } {
  const calls: any[] = [];
  const store: AttestationStore = {
    profile: {
      upsert: async (a) => {
        calls.push(['profile.upsert', a]);
        return { id: 'p1' };
      },
    },
    wallet: {
      upsert: async (a) => {
        calls.push(['wallet.upsert', a]);
      },
      deleteMany: async (a) => {
        calls.push(['wallet.deleteMany', a]);
      },
    },
  };
  return { store, calls };
}

test('applyAttestation upserts profile then links wallet on claim', async () => {
  const { store, calls } = recordingStore();
  await applyAttestation(store, { kind: 'claimed', handle: 'aquawolf', wallet: 'GWALLET' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'profile.upsert');
  assert.equal(calls[0][1].where.handle, 'aquawolf');
  assert.equal(calls[1][0], 'wallet.upsert');
  assert.equal(calls[1][1].where.pubkey, 'GWALLET');
  assert.equal(calls[1][1].create.profileId, 'p1');
  assert.equal(calls[1][1].update.source, 'onchain');
});

test('applyAttestation removes the binding on release', async () => {
  const { store, calls } = recordingStore();
  await applyAttestation(store, { kind: 'released', handle: 'aquawolf', wallet: 'GWALLET' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'wallet.deleteMany');
  assert.equal(calls[0][1].where.pubkey, 'GWALLET');
});
