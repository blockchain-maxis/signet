import { StrKey } from '@stellar/stellar-sdk';

/**
 * Database fixtures for the docs accessibility e2e (#472).
 *
 * TEST-ONLY DATA, like `contracts.ts` and `docs-failures.ts`: it exists to put
 * a known interface in front of the docs tabs in the throwaway Postgres the
 * `e2e-linked` job provides, and is never seeded by a deployment.
 *
 * The docs tabs read an interface from the `ContractSpec` store keyed by WASM
 * hash before they ask any RPC, so a stored, hand-written `SpecJson` is a
 * complete "test-only loader override": no RPC call, no network, and the
 * rendered page is exactly what the spec says.
 *
 *   e2e-registry (profile)
 *     └─ wallet 4 ── REGISTRY      a registry-shaped contract: 8 functions,
 *                 │                 3 types, 1 error enum, doc comments
 *                 └─ UNDOCUMENTED   2 functions and 1 type, no doc comments at
 *                                   all, one of them with a long signature
 *
 * The profile is separate from `e2e-dev` and `e2e-docs` so the contract-list
 * specs on those profiles keep their counts.
 */

export const REGISTRY_HANDLE = 'e2e-registry';

const contractId = (byte: number) => StrKey.encodeContract(Buffer.alloc(32, byte));

export const REGISTRY = contractId(0xa7);
export const UNDOCUMENTED = contractId(0xa8);

const WALLET_4 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0xe4));
const REGISTRY_WASM = '33'.repeat(32);
const UNDOCUMENTED_WASM = '44'.repeat(32);

/** The SDK the e2e server runs (`RUNNING_SDK_VERSION`); a row stamped with another is stale and re-read over RPC. */
const SDK_VERSION = '16.1.0';

/** The 8 functions of the registry fixture, in declaration order. */
export const REGISTRY_FUNCTIONS = [
  'claim',
  'resolve',
  'transfer',
  'release',
  'owner_of',
  'status',
  'list_by_owner',
  'set_metadata',
] as const;

const named = (name: string) => ({ type: 'named', name }) as const;
const RESULT_BINDING = { type: 'result', ok: named('Binding'), error: named('RegistryError') };
const RESULT_VOID = { type: 'result', ok: 'void', error: named('RegistryError') };

const registrySpec = {
  schemaVersion: 1,
  wasmHash: REGISTRY_WASM,
  sdkVersion: SDK_VERSION,
  entriesXdr: [],
  functions: [
    {
      name: 'claim',
      doc: 'Claims a handle for an owner. Fails if the handle is already taken.',
      isConstructor: false,
      inputs: [
        { name: 'handle', type: 'symbol' },
        { name: 'owner', type: 'address' },
      ],
      outputs: [RESULT_BINDING],
    },
    {
      name: 'resolve',
      doc: 'Looks a handle up.',
      isConstructor: false,
      inputs: [{ name: 'handle', type: 'symbol' }],
      outputs: [{ type: 'option', value: named('Binding') }],
    },
    {
      name: 'transfer',
      doc: 'Moves a handle to a new owner.',
      isConstructor: false,
      inputs: [
        { name: 'handle', type: 'symbol' },
        { name: 'to', type: 'address' },
      ],
      outputs: [RESULT_VOID],
    },
    {
      name: 'release',
      doc: 'Gives a handle up.',
      isConstructor: false,
      inputs: [{ name: 'handle', type: 'symbol' }],
      outputs: [RESULT_VOID],
    },
    {
      name: 'owner_of',
      doc: '',
      isConstructor: false,
      inputs: [{ name: 'handle', type: 'symbol' }],
      outputs: [{ type: 'option', value: 'address' }],
    },
    {
      name: 'status',
      doc: '',
      isConstructor: false,
      inputs: [{ name: 'handle', type: 'symbol' }],
      outputs: [named('HandleStatus')],
    },
    {
      name: 'list_by_owner',
      doc: 'Lists the handles an owner holds, one page at a time.',
      isConstructor: false,
      inputs: [
        { name: 'owner', type: 'address' },
        { name: 'page', type: 'u32' },
      ],
      outputs: [{ type: 'vec', element: named('Binding') }],
    },
    {
      name: 'set_metadata',
      doc: 'Attaches key and value pairs to a handle.',
      isConstructor: false,
      inputs: [
        { name: 'handle', type: 'symbol' },
        { name: 'entries', type: { type: 'map', key: 'symbol', value: 'string' } },
        { name: 'expires_at', type: 'timepoint' },
        { name: 'previous_owner', type: { type: 'option', value: 'address' } },
        { name: 'status', type: named('HandleStatus') },
      ],
      outputs: [RESULT_VOID],
    },
  ],
  types: [
    {
      kind: 'struct',
      name: 'Binding',
      doc: 'A handle and the wallet that holds it.',
      fields: [
        { name: 'handle', type: 'symbol' },
        { name: 'owner', type: 'address' },
        { name: 'status', type: named('HandleStatus') },
      ],
    },
    {
      kind: 'enum',
      name: 'HandleStatus',
      doc: 'Where a handle is in its life.',
      variants: [
        { name: 'Active', value: 0 },
        { name: 'Released', value: 1 },
      ],
    },
    {
      kind: 'union',
      name: 'Lookup',
      cases: [
        { name: 'Found', fields: [{ name: '0', type: named('Binding') }] },
        { name: 'Missing', fields: [] },
      ],
    },
  ],
  errors: [
    { enumName: 'RegistryError', name: 'HandleTaken', value: 1, doc: 'The handle belongs to someone else.' },
    { enumName: 'RegistryError', name: 'NotOwner', value: 2, doc: 'The caller does not hold the handle.' },
  ],
  events: [],
  build: { rustVersion: '1.91.1', sdkVersion: '26.1.0' },
  env: { protocolVersion: 23, preRelease: 0 },
  warnings: [],
};

/** No doc comment anywhere, and a signature long enough to wrap on a phone. */
const undocumentedSpec = {
  schemaVersion: 1,
  wasmHash: UNDOCUMENTED_WASM,
  sdkVersion: SDK_VERSION,
  entriesXdr: [],
  functions: [
    {
      name: 'ping',
      doc: '',
      isConstructor: false,
      inputs: [],
      outputs: ['void'],
    },
    {
      name: 'record_observation_with_a_deliberately_long_function_name',
      doc: '',
      isConstructor: false,
      inputs: [
        { name: 'observer_account_identifier', type: 'address' },
        {
          name: 'observation_payload',
          type: { type: 'map', key: 'symbol', value: { type: 'vec', element: 'bytes' } },
        },
        { name: 'observed_at_ledger_timestamp', type: 'timepoint' },
        { name: 'maybe_previous_observation', type: { type: 'option', value: named('Observation') } },
      ],
      outputs: [named('Observation')],
    },
  ],
  types: [{ kind: 'struct', name: 'Observation', fields: [{ name: 'at', type: 'timepoint' }] }],
  errors: [],
  events: [],
  warnings: [],
};

/** Seed the e2e-registry profile, its two contracts and their stored interfaces. Idempotent. */
export async function seedDocsRegistryFixture(): Promise<void> {
  const { prisma } = await import('@signet/db');
  try {
    const profile = await prisma.profile.upsert({
      where: { handle: REGISTRY_HANDLE },
      update: {},
      create: { handle: REGISTRY_HANDLE },
    });
    const wallet = await prisma.wallet.upsert({
      where: { pubkey: WALLET_4 },
      update: { profileId: profile.id },
      create: { profileId: profile.id, pubkey: WALLET_4, source: 'cli', isPrimary: true },
    });
    const rows = [
      { address: REGISTRY, tx: 'a7', wasm: REGISTRY_WASM, spec: registrySpec },
      { address: UNDOCUMENTED, tx: 'a8', wasm: UNDOCUMENTED_WASM, spec: undocumentedSpec },
    ];
    for (const row of rows) {
      const data = {
        walletId: wallet.id,
        deployerPubkey: WALLET_4,
        deployedAt: new Date('2026-04-02T12:00:00Z'),
        deployTxHash: row.tx.repeat(32),
        network: 'testnet',
        wasmHash: row.wasm,
        executableType: 'wasm',
      };
      await prisma.contract.upsert({
        where: { address: row.address },
        update: data,
        create: { address: row.address, ...data },
      });
      await prisma.contractSpec.upsert({
        where: { wasmHash: row.wasm },
        update: { schemaVersion: 1, sdkVersion: SDK_VERSION, specJson: row.spec },
        create: { wasmHash: row.wasm, schemaVersion: 1, sdkVersion: SDK_VERSION, specJson: row.spec },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}
