import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contract, xdr } from '@stellar/stellar-sdk';
import type {
  ContractSpec,
  SpecFunction,
  SpecStruct,
  SpecUnion,
  SpecEnum,
  SpecErrorCase,
  SpecEvent,
  TypeRef,
} from './types.ts';
import {
  ContractNotFound,
  NoInterface,
  InterfaceUnreadable,
  RpcUnavailable,
  InvalidWasm,
  isSpecReadError,
  SpecReadError,
  type ConcreteSpecReadError,
} from './errors.ts';

test('ContractSpec type-level shape compilation using satisfies', () => {
  const dummyEntry = xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name: 'initialize',
      inputs: [],
      outputs: [],
    }),
  );
  const dummySpec = new contract.Spec([dummyEntry]);

  const mockSpec = {
    wasmHash: 'a'.repeat(64),
    entries: [dummyEntry] as readonly xdr.ScSpecEntry[],
    spec: dummySpec,
    functions: [
      {
        name: 'initialize',
        doc: 'Initializes the contract owner and settings',
        inputs: [
          {
            name: 'admin',
            doc: 'Admin address',
            type: 'address',
          },
        ],
        outputs: ['void'],
      },
      {
        name: 'get_entry',
        doc: 'Fetches an entry by ID',
        inputs: [
          {
            name: 'id',
            type: { type: 'bytes_n', n: 32 },
          },
        ],
        outputs: [
          {
            type: 'option',
            value: { type: 'named', name: 'RegistryEntry' },
          },
        ],
      },
      {
        name: 'try_transfer',
        inputs: [
          {
            name: 'recipient',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'i128',
          },
        ],
        outputs: [
          {
            type: 'result',
            ok: 'bool',
            error: { type: 'named', name: 'ContractError' },
          },
        ],
      },
      {
        name: 'batch_op',
        inputs: [
          {
            name: 'items',
            type: { type: 'vec', element: 'string' },
          },
          {
            name: 'mapping',
            type: { type: 'map', key: 'symbol', value: 'u64' },
          },
          {
            name: 'coords',
            type: { type: 'tuple', elements: ['i32', 'i32'] },
          },
          {
            name: 'future_val',
            type: { type: 'unknown', xdrArm: 'scSpecTypeFutureArm' },
          },
        ],
        outputs: ['void'],
      },
    ] satisfies readonly SpecFunction[],
    types: [
      {
        kind: 'struct',
        name: 'RegistryEntry',
        doc: 'On-chain identity binding record',
        fields: [
          { name: 'owner', type: 'address' },
          { name: 'handle', type: 'string' },
        ],
      } satisfies SpecStruct,
      {
        kind: 'union',
        name: 'AccountStatus',
        doc: 'Status state of an account',
        cases: [
          { name: 'Active', fields: [] },
          { name: 'Suspended', fields: [{ name: 'until', type: 'timepoint' }] },
        ],
      } satisfies SpecUnion,
      {
        kind: 'enum',
        name: 'Role',
        doc: 'Role level enum',
        variants: [
          { name: 'User', value: 0 },
          { name: 'Admin', value: 1 },
        ],
      } satisfies SpecEnum,
    ],
    errors: [
      {
        enumName: 'ContractError',
        name: 'AlreadyInitialized',
        value: 1,
        doc: 'The contract has already been initialized',
      },
      {
        enumName: 'ContractError',
        name: 'NotAuthorized',
        value: 2,
        doc: 'Caller is not authorized',
      },
    ] satisfies readonly SpecErrorCase[],
    events: [
      {
        name: 'transferred',
        doc: 'Emitted when assets are transferred',
        topics: [
          { name: 'symbol', type: 'symbol' },
          { name: 'from', type: 'address' },
        ],
        data: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'i128' },
        ],
      },
    ] satisfies readonly SpecEvent[],
    build: {
      rustVersion: '1.91.1',
      sdkVersion: '26.1.0',
    },
    env: {
      protocolVersion: 23,
      preRelease: 0,
    },
    sdkVersion: '16.1.0',
  } satisfies ContractSpec;

  assert.equal(mockSpec.functions.length, 4);
  assert.equal(mockSpec.types.length, 3);
  assert.equal(mockSpec.errors.length, 2);
  assert.equal(mockSpec.events.length, 1);
  assert.equal(mockSpec.sdkVersion, '16.1.0');
});

test('SpecReadError subclasses discriminate cleanly by kind', () => {
  const errors: ConcreteSpecReadError[] = [
    new ContractNotFound('CDUMMY...', 'testnet'),
    new NoInterface('no_section'),
    new NoInterface('stellar_asset_contract'),
    new InterfaceUnreadable('16.1.0', new Error('decode err')),
    new RpcUnavailable('https://soroban-testnet.stellar.org', new Error('ECONNREFUSED')),
    new InvalidWasm(new Error('bad magic header')),
  ];

  for (const err of errors) {
    assert.equal(isSpecReadError(err), true);
    assert.equal(err instanceof SpecReadError, true);
    assert.equal(err instanceof Error, true);

    switch (err.kind) {
      case 'contract_not_found':
        assert.equal(err.address, 'CDUMMY...');
        assert.equal(err.network, 'testnet');
        break;
      case 'no_interface':
        assert.ok(
          err.reason === 'no_section' ||
            err.reason === 'stellar_asset_contract' ||
            err.reason === 'empty_section',
        );
        break;
      case 'interface_unreadable':
        assert.equal(err.sdkVersion, '16.1.0');
        assert.ok(err.cause);
        break;
      case 'rpc_unavailable':
        assert.equal(err.rpcUrl, 'https://soroban-testnet.stellar.org');
        assert.ok(err.cause);
        break;
      case 'invalid_wasm':
        assert.ok(err.cause);
        break;
      default: {
        const _unreachable: never = err;
        assert.fail(`Unexpected error kind: ${_unreachable}`);
      }
    }
  }

  assert.equal(isSpecReadError(new Error('generic')), false);
  assert.equal(isSpecReadError(null), false);
  assert.equal(isSpecReadError(undefined), false);
  assert.equal(isSpecReadError({ kind: 'custom' }), false);
});
