/**
 * @file Capture a real contract's spec as a committed test fixture (#483).
 *
 *   node --experimental-strip-types scripts/capture-fixture.mts <address> <network> <name> [rpcUrl]
 *
 * Run by hand only: it talks to a live RPC endpoint. It is never part of the
 * test run or CI. It reads the spec through `fetchContractSpec` (#433), asks the
 * same endpoint for its latest ledger, and writes `fixtures/<name>.spec.json`.
 * `capturedAtLedger` is the endpoint's latest ledger just after the fetch, an
 * upper bound on the state that was read.
 *
 * Afterwards, add the fixture's provenance (source repo, licence) to
 * `fixtures/README.md` by hand.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '@stellar/stellar-sdk';
import { fetchContractSpec } from '@signet/spec/fetch';

type FetchNetwork = Parameters<typeof fetchContractSpec>[1]['network'];

/** Public Soroban RPC endpoints; override with the fourth argument. */
const DEFAULT_RPC: Record<string, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://mainnet.sorobanrpc.com',
};

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

async function main(): Promise<void> {
  const [address, network, name, rpcArg] = process.argv.slice(2);
  if (!address || !network || !name) {
    console.error('usage: capture-fixture.mts <address> <network> <name> [rpcUrl]');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error(`invalid fixture name "${name}": use lowercase letters, numbers and dashes`);
    process.exit(2);
  }
  const rpcUrl = rpcArg ?? DEFAULT_RPC[network];
  if (!rpcUrl) {
    console.error(`no default RPC for network "${network}"; pass an rpcUrl`);
    process.exit(2);
  }

  const spec = await fetchContractSpec(address, {
    network: network as FetchNetwork,
    rpcUrl,
    signal: AbortSignal.timeout(120_000),
  });
  const { sequence } = await new rpc.Server(rpcUrl).getLatestLedger();

  const fixture = {
    network,
    address,
    wasmHash: spec.wasmHash,
    capturedAtLedger: sequence,
    entriesXdrBase64: spec.entries.map((entry) => entry.toXDR('base64') as string),
  };
  const file = join(FIXTURES_DIR, `${name}.spec.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `wrote ${file}: ${fixture.entriesXdrBase64.length} entries, wasm ${fixture.wasmHash}, ledger ${sequence}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
