import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, Keypair, xdr } from '@stellar/stellar-sdk';
import { parseContractSpec } from '../parse.ts';
import { normaliseFootprint } from '../observe/normalise.ts';
import { TESTNET_REGISTRY, claimFixture, countFixture } from '../observe/testnet-fixtures.ts';
import { groupLedgerKeys, keyShape } from './shape.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
// types_zoo declares `enum Color { Red = 1, Green = 2 }` and
// `union Shape { Point(u32, u32), Empty }`.
const zoo = parseContractSpec(readFileSync(join(FIXTURES_DIR, 'types_zoo.wasm')));

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const vec = (...items: xdr.ScVal[]) => xdr.ScVal.scvVec(items);
const account = () => Address.fromString(Keypair.random().publicKey()).toScVal();

test('a symbol-only key keeps the symbol as its shape', () => {
  assert.deepEqual(keyShape(sym('COUNTER'), zoo), { shape: 'COUNTER' });
});

test('a union-cased key is matched to the spec union by case name and arity', () => {
  const point = vec(sym('Point'), xdr.ScVal.scvU32(3), xdr.ScVal.scvU32(4));
  assert.deepEqual(keyShape(point, zoo), { shape: 'Point(U32, U32)', specType: 'Shape' });
  // A field-less case encodes as a one-element vector.
  assert.deepEqual(keyShape(vec(sym('Empty')), zoo), { shape: 'Empty', specType: 'Shape' });
  // An enum variant name fits a field-less key.
  assert.deepEqual(keyShape(sym('Green'), zoo), { shape: 'Green', specType: 'Color' });
});

test('a key with no spec match still has a shape, and no specType', () => {
  // The case name fits, the arity does not.
  const wrongArity = vec(sym('Point'), xdr.ScVal.scvU32(3));
  assert.deepEqual(keyShape(wrongArity, zoo), { shape: 'Point(U32)' });
  assert.equal('specType' in keyShape(wrongArity, zoo), false);
  assert.deepEqual(keyShape(vec(sym('Balance'), account())), { shape: 'Balance(Address)' });
});

test('bytes, addresses and numbers are replaced by their type names', () => {
  const contract = Address.fromString(TESTNET_REGISTRY).toScVal();
  const key = vec(sym('Allowance'), account(), contract, xdr.ScVal.scvBytes(Buffer.alloc(32, 7)), xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('5') }),
  ));
  assert.equal(keyShape(key).shape, 'Allowance(Address, Address, Bytes, I128)');
  // Two keys differing only in their concrete values share a shape.
  assert.equal(keyShape(vec(sym('Balance'), account())).shape, keyShape(vec(sym('Balance'), account())).shape);
  // Non-case vectors are tuples; symbol-keyed maps keep their field names.
  assert.equal(keyShape(vec(xdr.ScVal.scvU64(xdr.Uint64.fromString('1')), xdr.ScVal.scvString('x'))).shape, '(U64, String)');
  const struct = xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: sym('owner'), val: account() })]);
  assert.equal(keyShape(struct).shape, '{owner: Address}');
});

test('registry claim footprints list the persistent handle and wallet slots, written by claim', () => {
  const observations = [normaliseFootprint(claimFixture), normaliseFootprint(countFixture)];
  const slots = groupLedgerKeys(observations, TESTNET_REGISTRY);

  assert.deepEqual(
    slots.map((s) => [s.durability, s.shape, s.writtenBy, s.readBy]),
    [
      ['instance', 'Instance', ['claim'], ['count']],
      // Handle(Address): wallet -> handle; Owner(String): handle -> owner.
      ['persistent', 'Handle(Address)', ['claim'], []],
      ['persistent', 'Owner(String)', ['claim'], []],
    ],
  );
  const handle = slots.find((s) => s.shape === 'Handle(Address)')!;
  assert.equal(handle.distinctKeys, 1);
  assert.equal(handle.firstSeenLedger, claimFixture.ledger);
  assert.equal(handle.lastSeenLedger, claimFixture.ledger);
  // The registry's DataKey is not exported in its spec, so nothing matches.
  assert.equal(handle.specType, undefined);
  // The instance is seen across both observations.
  const instance = slots[0]!;
  assert.equal(instance.firstSeenLedger, claimFixture.ledger);
  assert.equal(instance.lastSeenLedger, countFixture.ledger);
});

test('only own data and instance keys become slots: nonces, accounts and other contracts are left out', () => {
  const slots = groupLedgerKeys([normaliseFootprint(claimFixture)], TESTNET_REGISTRY);
  assert.ok(slots.every((s) => s.shape !== 'Nonce'), 'the signer nonce is not registry storage');
  assert.deepEqual(groupLedgerKeys([normaliseFootprint(claimFixture)], 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'), []);
});

test('distinct concrete keys of one shape fold into one slot', () => {
  const contract = Address.fromString(TESTNET_REGISTRY);
  const dataKey = (key: xdr.ScVal) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contract.toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ).toXDR('base64');
  const a = dataKey(vec(sym('Balance'), account()));
  const b = dataKey(vec(sym('Balance'), account()));
  const raw = (fn: string, ledger: number, readWrite: string[]) =>
    normaliseFootprint({ contract: TESTNET_REGISTRY, function: fn, source: 'transaction', ledger, readOnly: [], readWrite, successful: true });

  const [slot] = groupLedgerKeys([raw('transfer', 10, [a, b]), raw('mint', 20, [b])], TESTNET_REGISTRY);
  assert.deepEqual(slot, {
    durability: 'persistent',
    shape: 'Balance(Address)',
    distinctKeys: 2,
    readBy: [],
    writtenBy: ['mint', 'transfer'],
    firstSeenLedger: 10,
    lastSeenLedger: 20,
  });
});
