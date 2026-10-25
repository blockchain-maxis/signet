import { StrKey } from '@stellar/stellar-sdk';

/**
 * Database fixture for the collapse/expand e2e (#502).
 *
 * TEST-ONLY DATA, like `contracts.ts`: one contract with 30 functions in
 * three name groups, past the collapse threshold (25), with a stored,
 * hand-written `SpecJson` so the Diagram tab draws without an RPC.
 *
 *   e2e-groups (profile)
 *     └─ wallet 5 ── GROUPED   pool_* (12), admin_* (6), get_* (12)
 *
 * Its own profile, so the contract-list specs on the others keep their counts.
 */

export const GROUPS_HANDLE = 'e2e-groups';
export const GROUPED = StrKey.encodeContract(Buffer.alloc(32, 0xaa));

const WALLET_5 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0xe5));
const GROUPED_WASM = '55'.repeat(32);
const SDK_VERSION = '16.1.0';

type Named = { type: 'named'; name: string };
const pool: Named = { type: 'named', name: 'Pool' };
const config: Named = { type: 'named', name: 'Config' };
const fn = (name: string, inputs: { name: string; type: Named }[], outputs: Named[] = []) => ({
  name,
  doc: '',
  isConstructor: false,
  inputs,
  outputs,
});

const groupedSpec = {
  schemaVersion: 1,
  wasmHash: GROUPED_WASM,
  sdkVersion: SDK_VERSION,
  entriesXdr: [],
  functions: [
    ...Array.from({ length: 12 }, (_, i) => fn(`pool_op${i}`, [{ name: 'pool', type: pool }])),
    ...Array.from({ length: 6 }, (_, i) => fn(`admin_op${i}`, [{ name: 'config', type: config }])),
    ...Array.from({ length: 12 }, (_, i) => fn(`get_op${i}`, [], [pool])),
  ],
  types: [
    { kind: 'struct', name: 'Pool', fields: [{ name: 'config', type: config }] },
    { kind: 'struct', name: 'Config', fields: [] },
  ],
  errors: [],
  events: [],
  warnings: [],
};

/** Seed the e2e-groups profile, its contract and stored interface. Idempotent. */
export async function seedGroupedFixture(): Promise<void> {
  const { prisma } = await import('@signet/db');
  try {
    const profile = await prisma.profile.upsert({
      where: { handle: GROUPS_HANDLE },
      update: {},
      create: { handle: GROUPS_HANDLE },
    });
    const wallet = await prisma.wallet.upsert({
      where: { pubkey: WALLET_5 },
      update: { profileId: profile.id },
      create: { profileId: profile.id, pubkey: WALLET_5, source: 'cli', isPrimary: true },
    });
    const data = {
      walletId: wallet.id,
      deployerPubkey: WALLET_5,
      deployedAt: new Date('2026-04-03T12:00:00Z'),
      deployTxHash: 'aa'.repeat(32),
      network: 'testnet',
      wasmHash: GROUPED_WASM,
      executableType: 'wasm',
    };
    await prisma.contract.upsert({
      where: { address: GROUPED },
      update: data,
      create: { address: GROUPED, ...data },
    });
    await prisma.contractSpec.upsert({
      where: { wasmHash: GROUPED_WASM },
      update: { schemaVersion: 1, sdkVersion: SDK_VERSION, specJson: groupedSpec },
      create: { wasmHash: GROUPED_WASM, schemaVersion: 1, sdkVersion: SDK_VERSION, specJson: groupedSpec },
    });
  } finally {
    await prisma.$disconnect();
  }
}
