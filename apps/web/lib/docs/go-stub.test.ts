import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson } from '@signet/spec';
import { GO_SDK_MODULE, generateGoStub, goExported } from './go-stub.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  toSpecJson(
    parseContractSpec(
      fs.readFileSync(path.resolve(here, '../../../../packages/spec/fixtures', name)),
    ),
  );

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const registry = fixture('identity-registry.wasm');
const zoo = fixture('types_zoo.wasm');

const registryStub = generateGoStub(registry, {
  contractName: 'registry',
  address: ADDRESS,
  network: 'testnet',
  wasmHash: registry.wasmHash,
});
const zooStub = generateGoStub(zoo, {
  contractName: 'types_zoo',
  address: ADDRESS,
  network: 'testnet',
  wasmHash: zoo.wasmHash,
});

// Snapshot of the registry stub. Regenerate after an intended generator change
// with: UPDATE_GOLDEN=1 pnpm --filter @signet/web test
test('the registry stub matches its snapshot', () => {
  const golden = path.join(here, '__snapshots__', 'go-stub.registry.go.golden');
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(golden), { recursive: true });
    fs.writeFileSync(golden, registryStub);
  }
  assert.equal(registryStub, fs.readFileSync(golden, 'utf8').replace(/\r\n/g, '\n'));
});

test('the header names the contract, network and WASM hash and says the stub is thin', () => {
  assert.match(registryStub, /^\/\/ Package registry is a THIN client stub/);
  assert.ok(registryStub.includes(`// Contract: ${ADDRESS}`));
  assert.ok(registryStub.includes('// Network:  testnet'));
  assert.ok(registryStub.includes(`// WASM:     ${registry.wasmHash}`));
  assert.ok(registryStub.includes('regenerate this file'));
  assert.ok(registryStub.includes('It does NOT simulate, sign, submit or decode'));
});

test('it imports the current Go SDK module, not the retired github.com/stellar/go', () => {
  assert.equal(GO_SDK_MODULE, 'github.com/stellar/go-stellar-sdk');
  assert.ok(zooStub.includes(`"${GO_SDK_MODULE}/xdr"`));
  assert.ok(!/"github\.com\/stellar\/go\//.test(zooStub));
});

test('one Build*Op func per non-constructor function, each ending in invoke', () => {
  for (const fn of zoo.functions.filter((f) => !f.isConstructor)) {
    const name = `Build${goExported(fn.name)}Op`;
    assert.ok(zooStub.includes(`func ${name}(`), `missing ${name}`);
    assert.ok(zooStub.includes(`return invoke(${JSON.stringify(fn.name)}, args)`));
  }
});

test('mapped types get Go types; the rest become xdr.ScVal with a comment', () => {
  assert.ok(zooStub.includes('func BuildWhoOp(who string)'));
  assert.ok(zooStub.includes('func BuildFlipOp(v_ bool)'));
  assert.ok(zooStub.includes('func BuildManyOp(v_ []uint32)'));
  assert.ok(zooStub.includes('func BuildMaybeOp(v_ *uint32)'));
  assert.ok(zooStub.includes('func BuildWhenOp(at uint64, lasts uint64)'));
  assert.ok(zooStub.includes('func BuildPaintOp(c Color)'));
  assert.ok(zooStub.includes('func BuildNestedOp(v_ Level1)'));
  // 128/256-bit ints, tuples, maps, results and unions have no typed mapping.
  assert.ok(zooStub.includes('e xdr.ScVal, f xdr.ScVal, g xdr.ScVal, h xdr.ScVal'));
  // `v` is renamed `v_`: the generated funcs declare their own `v`.
  for (const raw of ['p', 'm', 'v_', 's']) {
    assert.match(
      zooStub,
      new RegExp(`// ${raw} is a raw xdr\\.ScVal: .+ has no typed mapping in this stub\\.`),
    );
  }
  assert.ok(zooStub.includes('func BuildPairOp(p xdr.ScVal)'));
  assert.ok(zooStub.includes('func BuildLookupOp(m xdr.ScVal)'));
  assert.ok(zooStub.includes('func BuildShapeOp(s xdr.ScVal)'));
});

test('structs encode as a map with sorted keys, enums as u32', () => {
  assert.ok(zooStub.includes('type Level1 struct {'));
  assert.ok(zooStub.includes('func (s Level1) ToScVal() (xdr.ScVal, error) {'));
  assert.ok(zooStub.includes('return scMap(entries)'));
  assert.ok(zooStub.includes('type Color uint32'));
  assert.match(zooStub, /scU32\(uint32\(c\)\)/);
});

test('the output is deterministic', () => {
  const again = generateGoStub(registry, {
    contractName: 'registry',
    address: ADDRESS,
    network: 'testnet',
    wasmHash: registry.wasmHash,
  });
  assert.equal(again, registryStub);
});

test('goExported makes exported Go identifiers', () => {
  assert.equal(goExported('transfer_from'), 'TransferFrom');
  assert.equal(goExported('get_handle'), 'GetHandle');
  assert.equal(goExported('0'), 'F0');
});
