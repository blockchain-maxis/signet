#!/usr/bin/env node
/**
 * Identity Registry storage keep-alive & restoration sweep tool.
 *
 * Soroban persistent storage entries (e.g. handle bindings) expire after ~30 days
 * (518,400 ledgers) without access. Reading an active entry bumps its TTL
 * automatically (see `IdentityRegistry::resolve`). This script periodically touches
 * bindings to keep them hot, preventing them from lapsing into cold archived storage.
 *
 * For entries that are already archived, it detects `restorePreamble` and reports
 * the required `RestoreFootprint` action.
 *
 * Usage:
 *   node scripts/keepalive-contract.mjs [handle1] [handle2] ...
 *
 * Env:
 *   SOROBAN_RPC_URL                    Soroban RPC endpoint (default: testnet)
 *   NEXT_PUBLIC_IDENTITY_REGISTRY_ID   Contract ID of the Identity Registry
 */

import { DEMO_PROFILES } from '../packages/types/src/index.ts';

const RPC_URL =
  process.env.SOROBAN_RPC_URL ??
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  'https://soroban-testnet.stellar.org';

const CONTRACT_ID =
  process.env.REGISTRY_CONTRACT_ID ??
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const cliHandles = process.argv.slice(2).filter((h) => !h.startsWith('-'));
const targetHandles = cliHandles.length > 0 ? cliHandles : DEMO_PROFILES.map((p) => p.handle);

if (!CONTRACT_ID) {
  console.error('Error: Identity Registry Contract ID is not set.');
  process.exit(1);
}

console.log(`\n--- Signet Identity Registry Keep-Alive Sweep ---`);
console.log(`Network RPC: ${RPC_URL}`);
console.log(`Registry ID: ${CONTRACT_ID}`);
console.log(`Target handles (${targetHandles.length}): ${targetHandles.join(', ')}\n`);

const { rpc, Account, BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal } =
  await import('@stellar/stellar-sdk');

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
const networkPassphrase =
  RPC_URL.includes('public') || RPC_URL.includes('mainnet') ? Networks.PUBLIC : Networks.TESTNET;

const contract = new Contract(CONTRACT_ID);

let touched = 0;
let archived = 0;
let unbound = 0;
let errors = 0;

for (const handle of targetHandles) {
  try {
    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call('resolve', nativeToScVal(handle, { type: 'string' })))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationRestore(sim)) {
      console.warn(`[ARCHIVED] ${handle}: persistent entry archived. Requires RestoreFootprint.`);
      archived += 1;
    } else if (rpc.Api.isSimulationError(sim)) {
      console.error(`[ERROR]    ${handle}: simulation error — ${sim.error}`);
      errors += 1;
    } else if (!sim.result) {
      console.warn(`[UNBOUND]  ${handle}: no result returned.`);
      unbound += 1;
    } else {
      console.log(`[OK]       ${handle}: TTL bumped successfully.`);
      touched += 1;
    }
  } catch (err) {
    console.error(`[FAIL]     ${handle}: ${err.message}`);
    errors += 1;
  }
}

console.log(
  `\nSweep summary: ${touched} live/bumped, ${archived} archived, ${unbound} unbound, ${errors} errors.\n`,
);
