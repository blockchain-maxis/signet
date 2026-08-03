/**
 * Server-side read access to the on-chain Identity Registry.
 *
 * Every function here is a *view* call: the registry's `resolve`, `lookup` and
 * `count` entrypoints are executed through `rpc.Server.simulateTransaction`,
 * which runs the contract against current ledger state and returns its value
 * without ever submitting anything. No keypair, no signing, no fee, no
 * database — which is the point: the web app can read live bindings in any
 * environment, including ones with no Postgres provisioned.
 *
 * Because the transaction is never submitted, the source account is a
 * throwaway placeholder (see `SIMULATION_SOURCE`). Simulation neither charges
 * it nor consumes its sequence number, and never requires it to exist.
 *
 * Failure is always soft. A missing contract id, an unreachable RPC endpoint,
 * a simulation error or a malformed return value all resolve to `null` (or `0`
 * for `boundCount`) rather than throwing, so a registry that isn't deployed
 * yet degrades a page instead of 500-ing it. Callers that need to tell "not
 * configured" apart from "not bound" should check `isRegistryConfigured()`.
 *
 * The client-side counterpart that *writes* bindings lives in `lib/registry.ts`;
 * the event-stream-based directory read lives in `lib/directory.ts`.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { isValidHandle } from '../profiles.ts';
import { isValidStellarAddress } from '../stellar-address.ts';

/**
 * Source account for simulated invocations. The all-zero account id is a valid
 * StrKey nobody holds the secret for — appropriate here precisely because the
 * transaction it sources is never signed or submitted.
 */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Just the slice of `rpc.Server` these reads need — keeps the calls stubbable. */
export interface SimulatingServer {
  simulateTransaction(tx: Transaction): Promise<unknown>;
}

export interface RegistryReadOptions {
  /** Override the RPC client. Tests inject a stub; production omits it. */
  server?: SimulatingServer;
}

/**
 * Resolved per call rather than at module load: Next.js server components and
 * the test runner both mutate `process.env` after this module is first
 * imported, and a stale snapshot there is a silently-unconfigured registry.
 */
function registryConfig() {
  const rpcUrl =
    process.env.SOROBAN_RPC_URL ??
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
    'https://soroban-testnet.stellar.org';
  const network = (
    process.env.STELLAR_NETWORK ??
    process.env.NEXT_PUBLIC_STELLAR_NETWORK ??
    'testnet'
  ).toLowerCase();

  return {
    contractId:
      process.env.REGISTRY_CONTRACT_ID ?? process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ?? '',
    rpcUrl,
    networkPassphrase:
      network === 'mainnet' || network === 'public' ? Networks.PUBLIC : Networks.TESTNET,
  };
}

export function isRegistryConfigured(): boolean {
  return registryConfig().contractId.length > 0;
}

/**
 * Simulate one view call and return its native return value.
 *
 * Returns `undefined` — deliberately distinct from a contract that returned
 * `null`/void — when the read could not be performed at all.
 */
async function simulateRead(
  method: string,
  args: xdr.ScVal[],
  options: RegistryReadOptions,
): Promise<unknown> {
  const { contractId, rpcUrl, networkPassphrase } = registryConfig();
  if (!contractId) return undefined;

  try {
    const server =
      options.server ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = (await server.simulateTransaction(tx)) as rpc.Api.SimulateTransactionResponse;
    if (!sim || rpc.Api.isSimulationError(sim)) return undefined;

    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) return undefined;
    return scValToNative(retval);
  } catch {
    // Unreachable RPC, malformed XDR, bad contract id — all soft failures.
    return undefined;
  }
}

/**
 * The wallet a handle is bound to, or null when it is unbound, the handle is
 * malformed, or the registry could not be read.
 */
export async function resolveHandle(
  handle: string,
  options: RegistryReadOptions = {},
): Promise<string | null> {
  if (!isValidHandle(handle)) return null;

  const wallet = await simulateRead(
    'resolve',
    [nativeToScVal(handle, { type: 'string' })],
    options,
  );

  return typeof wallet === 'string' && isValidStellarAddress(wallet) ? wallet : null;
}

/**
 * Reverse lookup: the handle a wallet owns, or null when it owns none, the
 * address is malformed, or the registry could not be read.
 */
export async function lookupWallet(
  address: string,
  options: RegistryReadOptions = {},
): Promise<string | null> {
  if (!isValidStellarAddress(address)) return null;

  const handle = await simulateRead('lookup', [new Address(address).toScVal()], options);

  return typeof handle === 'string' && isValidHandle(handle) ? handle : null;
}

/**
 * Number of currently-bound handles. Falls back to 0 — the same answer as an
 * empty registry — when the read fails, since callers use this for display
 * counts rather than control flow.
 */
export async function boundCount(options: RegistryReadOptions = {}): Promise<number> {
  const raw = await simulateRead('count', [], options);

  const count = typeof raw === 'bigint' ? Number(raw) : raw;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0;
}
