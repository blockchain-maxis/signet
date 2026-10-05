import { StrKey } from '@stellar/stellar-sdk';

/**
 * Database fixture for the contract-page e2e (#463).
 *
 * TEST-ONLY DATA. Every row written here exists to exercise the contract page
 * in the throwaway Postgres that the `e2e-linked` CI job (or a developer's
 * local database) provides. It is never shipped, never seeded by a deployment
 * and never rendered outside an e2e run: synthetic demo profiles were removed
 * from the product on purpose, and this file must not become a way back.
 *
 * Shape:
 *
 *   e2e-dev (profile)
 *     ├─ wallet 1 ── contract A (configured network)  ┐ listed on the profile
 *     │           └─ contract C (the OTHER network)   │ C is not: wrong network
 *     └─ wallet 2 ── contract B (configured network)  ┘
 *
 * "A contract owned by a different profile" needs no row: asking for A under a
 * handle that did not deploy it is the case, so the spec requests
 * `/p/e2e-other/contract/A`.
 *
 * Idempotent: every write is an upsert (or delete-then-create for the
 * snapshot rows, which have no natural key), so re-running against a database
 * that already holds the fixture converges instead of failing or duplicating.
 * The handle contains a hyphen, which `claim-link-profile.spec.ts`'s
 * per-run `e2e<base36>` handles never do, so the two cannot collide.
 */

export const FIXTURE_HANDLE = 'e2e-dev';
/** A handle that exists in no table: used to ask for a contract it did not deploy. */
export const OTHER_HANDLE = 'e2e-other';

/** Real StrKeys: `isContractAddress` verifies the checksum, so padding will not do. */
const contractId = (byte: number) => StrKey.encodeContract(Buffer.alloc(32, byte));
const accountId = (byte: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, byte));

export const CONTRACT_A = contractId(0xa1); // wallet 1, configured network
export const CONTRACT_B = contractId(0xb2); // wallet 2, configured network
export const CONTRACT_C = contractId(0xc3); // wallet 1, other network
export const MALFORMED_ADDRESS = 'CNOTAREALCONTRACTADDRESS';

export const WALLET_1 = accountId(0xe1);
export const WALLET_2 = accountId(0xe2);

/** Deploy transaction hash of contract A (the header links to it, #448). */
export const DEPLOY_TX_A = 'a1'.repeat(32);

/** The network the e2e server is configured for (`NEXT_PUBLIC_STELLAR_NETWORK` unset = testnet). */
export const CONFIGURED_NETWORK = 'testnet';
export const OTHER_NETWORK = 'mainnet';

const WASM_HASH_1 = '11'.repeat(32);
const WASM_HASH_2 = '22'.repeat(32);

/** Fixed timestamps keep the fixture byte-identical between runs. */
const at = (iso: string) => new Date(iso);

export async function seedContractFixture(): Promise<void> {
  const { prisma } = await import('@signet/db');
  try {
    // Fixture-only profile and wallets.
    const profile = await prisma.profile.upsert({
      where: { handle: FIXTURE_HANDLE },
      update: {},
      create: { handle: FIXTURE_HANDLE },
    });
    const wallets = [];
    for (const [pubkey, isPrimary] of [
      [WALLET_1, true],
      [WALLET_2, false],
    ] as const) {
      wallets.push(
        await prisma.wallet.upsert({
          where: { pubkey },
          update: { profileId: profile.id },
          create: { profileId: profile.id, pubkey, source: 'cli', isPrimary },
        }),
      );
    }

    // Fixture-only contracts.
    const contracts = [
      { address: CONTRACT_A, wallet: wallets[0]!, pubkey: WALLET_1, network: CONFIGURED_NETWORK, tx: DEPLOY_TX_A, day: '2026-03-01', wasm: WASM_HASH_2 },
      { address: CONTRACT_B, wallet: wallets[1]!, pubkey: WALLET_2, network: CONFIGURED_NETWORK, tx: 'b2'.repeat(32), day: '2026-02-01', wasm: WASM_HASH_1 },
      { address: CONTRACT_C, wallet: wallets[0]!, pubkey: WALLET_1, network: OTHER_NETWORK, tx: 'c3'.repeat(32), day: '2026-01-01', wasm: WASM_HASH_1 },
    ];
    const rows = [];
    for (const c of contracts) {
      const data = {
        walletId: c.wallet.id,
        deployerPubkey: c.pubkey,
        deployedAt: at(`${c.day}T12:00:00Z`),
        deployTxHash: c.tx,
        network: c.network,
        wasmHash: c.wasm,
        executableType: 'wasm',
      };
      rows.push(
        await prisma.contract.upsert({
          where: { address: c.address },
          update: data,
          create: { address: c.address, ...data },
        }),
      );
    }
    const [a, b] = rows as [(typeof rows)[number], (typeof rows)[number]];

    // Fixture-only snapshots. ContractSnapshot has no natural key, so replace.
    // (#429 adds `countedSince`; once that column exists, set it here the way
    // the snapshot worker does.)
    await prisma.contractSnapshot.deleteMany({ where: { contractId: { in: rows.map((r) => r.id) } } });
    await prisma.contractSnapshot.createMany({
      data: [
        { contractId: a.id, capturedAt: at('2026-03-10T00:00:00Z'), txCount24h: 3, txCountTotal: 42, lastActivity: at('2026-03-10T08:30:00Z') },
        { contractId: b.id, capturedAt: at('2026-03-10T00:00:00Z'), txCount24h: 0, txCountTotal: 7, lastActivity: at('2026-02-20T10:00:00Z') },
      ],
    });

    // Fixture-only decoded interface for contract A's WASM hash, so the Overview
    // renders without an RPC call. A hand-written `SpecJson` (2 functions, 1
    // documented, 1 type, 1 error case), stamped with the SDK the server runs so
    // the store does not treat it as stale.
    const specJson = {
      schemaVersion: 1,
      wasmHash: WASM_HASH_2,
      sdkVersion: '16.1.0',
      entriesXdr: [],
      functions: [
        { name: 'claim', doc: 'Claims a handle for a wallet.', isConstructor: false, inputs: [], outputs: ['void'] },
        { name: 'resolve', doc: '', isConstructor: false, inputs: [], outputs: ['address'] },
      ],
      types: [{ kind: 'struct', name: 'Binding', fields: [] }],
      errors: [{ enumName: 'RegistryError', name: 'HandleTaken', value: 1, doc: '' }],
      events: [],
      build: { rustVersion: '1.91.1', sdkVersion: '26.1.0' },
      env: { protocolVersion: 23, preRelease: 0 },
      warnings: [],
    };
    await prisma.contractSpec.upsert({
      where: { wasmHash: WASM_HASH_2 },
      update: { schemaVersion: 1, sdkVersion: '16.1.0', specJson },
      create: { wasmHash: WASM_HASH_2, schemaVersion: 1, sdkVersion: '16.1.0', specJson },
    });

    // Fixture-only invocations (composite id `${txHash}:${opIndex}`, as the capture worker writes).
    for (let i = 0; i < 4; i++) {
      const txHash = `${(0xd0 + i).toString(16)}`.repeat(32);
      const id = `${txHash}:0`;
      const data = {
        contractId: a.id,
        txHash,
        ledger: 1_000_000 + i,
        createdAt: at(`2026-03-0${i + 2}T09:00:00Z`),
        sourceAccount: WALLET_1,
        function: i % 2 === 0 ? 'claim' : 'resolve',
        successful: i !== 3,
        wasmHash: WASM_HASH_2,
        readOnly: [],
        readWrite: [],
        eventsContractIds: [],
      };
      await prisma.contractInvocation.upsert({ where: { id }, update: data, create: { id, ...data } });
    }

    // Fixture-only WASM version history for contract A (an upgrade from hash 1 to hash 2).
    for (const [wasmHash, day, ledger] of [
      [WASM_HASH_1, '2026-03-01', 999_000],
      [WASM_HASH_2, '2026-03-05', 1_000_500],
    ] as const) {
      await prisma.contractWasmVersion.upsert({
        where: { contractId_wasmHash: { contractId: a.id, wasmHash } },
        update: { observedAt: at(`${day}T12:00:00Z`), observedLedger: ledger },
        create: { contractId: a.id, wasmHash, observedAt: at(`${day}T12:00:00Z`), observedLedger: ledger },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}
