import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAIRING_EVENTS,
  PairingSecretLeakError,
  pairingEvent,
  type PairingOutcome,
} from './pairing.ts';

const OUTCOMES: PairingOutcome[] = ['started', 'completed', 'rejected', 'unlinked'];

test('every stage of a link has its own event name', () => {
  const names = OUTCOMES.map((outcome) => pairingEvent(outcome).name);

  assert.deepEqual(names, [
    'pairing.linkStarted',
    'pairing.linkCompleted',
    'pairing.linkRejected',
    'pairing.unlinked',
  ]);
  assert.equal(new Set(names).size, OUTCOMES.length);
  assert.deepEqual(Object.keys(PAIRING_EVENTS).sort(), [...OUTCOMES].sort());
});

test('an event carries handle, wallet and outcome', () => {
  const { fields } = pairingEvent('completed', {
    handle: 'aquawolf',
    wallet: 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD',
    ledger: 4_426_886,
    source: 'attestation-worker',
  });

  assert.equal(fields.outcome, 'completed');
  assert.equal(fields.handle, 'aquawolf');
  assert.equal(fields.wallet, 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD');
  assert.equal(fields.ledger, 4_426_886);
});

test('absent fields are omitted rather than logged as null', () => {
  const { fields } = pairingEvent('rejected', {
    handle: null,
    wallet: undefined,
    reason: 'undecodable-event',
  });

  assert.deepEqual(Object.keys(fields).sort(), ['outcome', 'reason']);
});

test('a field named like a secret is refused', () => {
  for (const key of ['secret', 'seed', 'signature', 'privateKey', 'passphrase', 'token']) {
    assert.throws(
      () => pairingEvent('completed', { handle: 'a', [key]: 'anything' } as never),
      PairingSecretLeakError,
      `expected ${key} to be refused`,
    );
  }
});

test('a value shaped like a secret seed is refused wherever it appears', () => {
  const seed = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5UEX5S6PYEEZ2ZCRECEQ4E5KX';

  assert.throws(() => pairingEvent('completed', { wallet: seed }), PairingSecretLeakError);
  assert.throws(
    () => pairingEvent('rejected', { reason: `bad request from ${seed}` }),
    PairingSecretLeakError,
  );
});

test('a public address is not mistaken for key material', () => {
  assert.doesNotThrow(() =>
    pairingEvent('unlinked', {
      wallet: 'GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ',
      reason: 'released',
    }),
  );
});
