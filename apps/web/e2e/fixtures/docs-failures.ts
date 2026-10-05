import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';

/**
 * Fixtures and a mock Soroban RPC for the docs failure-state e2e (#470).
 *
 * TEST-ONLY DATA, like `contracts.ts`. The docs tabs ask the RPC for a
 * contract's interface, so the failure states can only be reached
 * deterministically by controlling what the RPC answers. The e2e web server
 * is pointed at `mockRpcUrl()` (see `playwright.config.ts`); this module
 * stands that endpoint up and seeds one attributed contract per state:
 *
 *   e2e-docs (profile)
 *     └─ wallet 3 ── NO_INTERFACE   WASM with no `contractspecv0` section
 *                 ├─ SAC            a Stellar Asset Contract instance
 *                 └─ RPC_DOWN       the RPC answers 503 for this contract
 *
 * The profile is separate from `e2e-dev` so the contract-list specs on that
 * profile keep their counts.
 */

export const DOCS_HANDLE = 'e2e-docs';

const contractId = (byte: number) => StrKey.encodeContract(Buffer.alloc(32, byte));

export const NO_INTERFACE = contractId(0xd4);
export const SAC = contractId(0xf6);
export const RPC_DOWN = contractId(0xe5);

const WALLET_3 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0xe3));

/** `\0asm` + version 1, no sections: a valid module with no interface. */
const EMPTY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const EMPTY_WASM_HASH = createHash('sha256').update(EMPTY_WASM).digest();

const DEFAULT_PORT = 3199;

/** Where the e2e server reads the RPC. A loopback port, so no real network is touched. */
export function mockRpcUrl(): string {
  return `http://127.0.0.1:${Number(process.env.E2E_RPC_PORT ?? DEFAULT_PORT)}`;
}

function instanceEntry(address: string, executable: xdr.ContractExecutable): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(address).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  );
}

type Answer = { status: number; entries?: { key: string; xdr: string }[] };

/** What `getLedgerEntries` returns for one requested key. */
function answerFor(keyXdr: string): Answer {
  const key = xdr.LedgerKey.fromXDR(keyXdr, 'base64');
  const reply = (data: xdr.LedgerEntryData): Answer => ({
    status: 200,
    entries: [{ key: keyXdr, xdr: data.toXDR('base64') }],
  });

  if (key.switch().name === 'contractCode') {
    return reply(
      xdr.LedgerEntryData.contractCode(
        new xdr.ContractCodeEntry({
          ext: new xdr.ContractCodeEntryExt(0),
          hash: EMPTY_WASM_HASH,
          code: EMPTY_WASM,
        }),
      ),
    );
  }
  if (key.switch().name !== 'contractData') return { status: 200, entries: [] };

  const address = Address.fromScAddress(key.contractData().contract()).toString();
  if (address === RPC_DOWN) return { status: 503 };
  if (address === NO_INTERFACE) {
    return reply(
      instanceEntry(address, xdr.ContractExecutable.contractExecutableWasm(EMPTY_WASM_HASH)),
    );
  }
  if (address === SAC) {
    return reply(instanceEntry(address, xdr.ContractExecutable.contractExecutableStellarAsset()));
  }
  // Any other contract: not on the ledger. Same answer a real RPC gives.
  return { status: 200, entries: [] };
}

/** Start the mock RPC. Returns a function that stops it. */
export async function startMockRpc(): Promise<() => Promise<void>> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let id: unknown = 1;
      try {
        const rpc = JSON.parse(body) as { id?: unknown; method?: string; params?: { keys?: string[] } };
        id = rpc.id ?? 1;
        if (rpc.method !== 'getLedgerEntries') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }));
          return;
        }
        const answer = answerFor(rpc.params?.keys?.[0] ?? '');
        if (answer.status !== 200) {
          res.writeHead(answer.status);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              entries: (answer.entries ?? []).map((e) => ({ ...e, lastModifiedLedgerSeq: 1_000_000 })),
              latestLedger: 1_000_001,
            },
          }),
        );
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });
  const url = new URL(mockRpcUrl());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(url.port), url.hostname, resolve);
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Seed the e2e-docs profile and its three contracts. Idempotent. */
export async function seedDocsFailureFixture(): Promise<void> {
  const { prisma } = await import('@signet/db');
  try {
    const profile = await prisma.profile.upsert({
      where: { handle: DOCS_HANDLE },
      update: {},
      create: { handle: DOCS_HANDLE },
    });
    const wallet = await prisma.wallet.upsert({
      where: { pubkey: WALLET_3 },
      update: { profileId: profile.id },
      create: { profileId: profile.id, pubkey: WALLET_3, source: 'cli', isPrimary: true },
    });
    const rows = [
      { address: NO_INTERFACE, tx: 'd4', wasm: EMPTY_WASM_HASH.toString('hex'), type: 'wasm' },
      { address: SAC, tx: 'f6', wasm: null, type: 'stellar_asset' },
      { address: RPC_DOWN, tx: 'e5', wasm: null, type: 'wasm' },
    ];
    for (const row of rows) {
      const data = {
        walletId: wallet.id,
        deployerPubkey: WALLET_3,
        deployedAt: new Date('2026-04-01T12:00:00Z'),
        deployTxHash: row.tx.repeat(32),
        network: 'testnet',
        wasmHash: row.wasm,
        executableType: row.type,
      };
      await prisma.contract.upsert({
        where: { address: row.address },
        update: data,
        create: { address: row.address, ...data },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}
