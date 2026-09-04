import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { logger } from './logger.js';

/**
 * Read-only registry access for the reconcile path (issue #189).
 *
 * The event stream is the indexer's primary input, but events are only served
 * inside the RPC's retention window — contract STATE has no such horizon. When
 * the cursor falls outside the servable window, these view simulations are how
 * the worker re-learns the truth instead of losing it. A simulation is free,
 * unsigned, and needs no funded account; the source below is a throwaway.
 *
 * Kept minimal on purpose (the fuller pattern lives in the web app's
 * `lib/server/registry-read.ts`, which the indexer deliberately does not
 * depend on).
 */

/** Any funded-ness is irrelevant for simulation; sequence is ignored too. */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** How many handles one `resolve_batch` call may carry (contract MAX_BATCH_SIZE). */
const BATCH_SIZE = 100;

/**
 * The read surface the reconcile pass needs. An interface so tests can inject
 * a fake instead of a Soroban RPC server, mirroring `AttestationStore`.
 */
export interface RegistryReader {
  /** Resolve each handle to its bound wallet (`null` = not bound), positionally. */
  resolveMany(handles: string[]): Promise<(string | null)[]>;
  /** The registry's own `count()`, or `null` when it could not be read. */
  count(): Promise<number | null>;
}

function passphraseFor(network: string): string {
  return network === 'mainnet' || network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
}

async function simulateRead(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const source = new Account(SIMULATION_SOURCE, '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method}: ${sim.error}`);
  }
  if (!sim.result) throw new Error(`simulate ${method}: no result`);
  return scValToNative(sim.result.retval);
}

/** Production `RegistryReader` over a Soroban RPC server. */
export function createRegistryReader(
  server: rpc.Server,
  contractId: string,
  network: string,
): RegistryReader {
  const passphrase = passphraseFor(network);
  const read = (method: string, args: xdr.ScVal[]) =>
    simulateRead(server, contractId, passphrase, method, args);

  // The deployed testnet wasm predates `resolve_batch`; when the batch call
  // fails we degrade to per-handle `resolve` instead of failing the sweep.
  let batchUnavailable = false;

  async function resolveChunk(chunk: string[]): Promise<(string | null)[]> {
    if (!batchUnavailable) {
      try {
        const raw = (await read('resolve_batch', [
          nativeToScVal(chunk, { type: 'string' }),
        ])) as (string | null)[];
        return raw.map((r) => (typeof r === 'string' ? r : null));
      } catch (err) {
        batchUnavailable = true;
        logger.debug(
          { error: String(err) },
          'registryRead.batchUnavailable — falling back to per-handle resolve',
        );
      }
    }
    const out: (string | null)[] = [];
    for (const handle of chunk) {
      const raw = await read('resolve', [nativeToScVal(handle, { type: 'string' })]);
      out.push(typeof raw === 'string' ? raw : null);
    }
    return out;
  }

  return {
    async resolveMany(handles) {
      const results: (string | null)[] = [];
      for (let i = 0; i < handles.length; i += BATCH_SIZE) {
        results.push(...(await resolveChunk(handles.slice(i, i + BATCH_SIZE))));
      }
      return results;
    },
    async count() {
      try {
        const raw = await read('count', []);
        const n = typeof raw === 'bigint' ? Number(raw) : raw;
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
      } catch (err) {
        // Not debug: a failed count() silently disarms the reconcile pass's
        // unknown-bindings cross-check, and whoever reads the reconcile log
        // needs to know the check did not run.
        logger.warn({ error: String(err) }, 'registryRead.countFailed');
        return null;
      }
    },
  };
}
