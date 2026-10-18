/**
 * @file @signet/spec
 *
 * Network half of the spec reader: fetches a deployed contract's instance entry
 * and WASM bytecode over Soroban RPC (§1.2 and §5 of docs/CONTRACT_DOCS_DESIGN.md).
 *
 * Node-only: published through the separate `@signet/spec/fetch` export path so
 * the browser-safe `@signet/spec` surface stays free of network access.
 */

import { Contract, rpc, StrKey } from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';
import type { Network } from '@signet/types';
import {
  ContractNotFound,
  InvalidWasm,
  NoInterface,
  RpcUnavailable,
  isSpecReadError,
} from './errors.ts';
import { MAX_WASM_BYTES, parseContractSpec } from './parse.ts';
import type { ContractSpec } from './types.ts';

/** Default deadline for a single fetch; callers override it through `opts.signal`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Maximum HTTP response body bytes accepted from Soroban RPC for a given
 * `maxWasmBytes` cap: base64 expansion (4/3) of the `ContractCodeEntry` XDR
 * plus 4 KB of headroom for the JSON-RPC envelope.
 */
export function maxRpcResponseBytes(maxWasmBytes: number = MAX_WASM_BYTES): number {
  return Math.ceil((maxWasmBytes + 64) * (4 / 3)) + 4_096;
}

/**
 * Minimal `rpc.Server` surface this module consumes, so tests can inject a stub
 * driven by recorded responses (#413).
 */
export interface SpecRpcServer {
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse>;
  getContractWasmByContractId(contractId: string): Promise<Buffer>;
}

/**
 * Options shared by {@link fetchWasmHash} and {@link fetchContractSpec}.
 */
export interface FetchOptions {
  /** Network the contract address belongs to (#411). */
  readonly network: Network;
  /** Soroban RPC endpoint; required — this package never guesses endpoints. */
  readonly rpcUrl: string;
  /** Permit plain-HTTP endpoints (the SDK rejects them by default). */
  readonly allowHttp?: boolean;
  /**
   * Cancellation/deadline signal. Defaults to `AbortSignal.timeout(10_000)`;
   * pass your own signal to configure the timeout.
   */
  readonly signal?: AbortSignal;
  /** Maximum allowed WASM byte size (defaults to {@link MAX_WASM_BYTES}). */
  readonly maxWasmBytes?: number;
  /** Injected `rpc.Server`-shaped client (tests); a real `rpc.Server` otherwise. */
  readonly server?: SpecRpcServer;
}

/**
 * Result of reading a contract's instance executable.
 *
 * `archived` is present, and `true`, only when the instance entry's TTL has
 * passed: the entry was returned, but it has expired and has to be restored
 * before the contract can be invoked. The hash it holds is the last one
 * recorded. An entry that has been evicted outright is not returned at all and
 * reads as `ContractNotFound`; the RPC does not say it was archived.
 */
export type WasmHashResult =
  | { readonly type: 'wasm'; readonly wasmHash: string; readonly archived?: true }
  | { readonly type: 'stellar_asset'; readonly archived?: true };

/**
 * Fetch the executable recorded in a contract's instance ledger entry.
 *
 * Performs exactly one `getLedgerEntries` call on the instance key.
 *
 * @param address - contract address in `C...` strkey form.
 * @param opts - network, required RPC endpoint, and optional overrides.
 * @returns the lower-case hex WASM hash, or a `stellar_asset` marker for a SAC.
 * @throws `ContractNotFound` when the instance entry is missing on `opts.network`,
 *   `RpcUnavailable` for transport failures, timeouts, or unreadable entries.
 */
export async function fetchWasmHash(address: string, opts: FetchOptions): Promise<WasmHashResult> {
  const { result } = await readInstance(address, opts);
  return result;
}

/**
 * Fetch and decode a deployed contract's interface specification.
 *
 * Reads the instance entry first; a SAC throws `NoInterface{stellar_asset_contract}`
 * without fetching any WASM, otherwise the module is fetched through
 * `getContractWasmByContractId`, decoded, and its hash asserted against the
 * instance hash.
 *
 * @param address - contract address in `C...` strkey form.
 * @param opts - network, required RPC endpoint, and optional overrides.
 * @returns the decoded `ContractSpec`.
 * @throws `NoInterface` for a SAC or a module without a spec section,
 *   `InvalidWasm` for a non-WASM or oversized module, `InterfaceUnreadable`
 *   when the spec section cannot be decoded by this SDK version,
 *   `ContractNotFound` when the instance entry is missing, `RpcUnavailable`
 *   for transport failures or an inconsistent endpoint response.
 */
export async function fetchContractSpec(
  address: string,
  opts: FetchOptions,
): Promise<ContractSpec> {
  const { server, result } = await readInstance(address, opts);
  if (result.type === 'stellar_asset') {
    throw new NoInterface('stellar_asset_contract');
  }
  const wasm = await rpcCall(opts, async () => {
    try {
      return await server.getContractWasmByContractId(address);
    } catch (cause) {
      if (cause instanceof Error && /maxContentLength/i.test(cause.message)) {
        throw new InvalidWasm(cause);
      }
      throw cause;
    }
  });
  const spec = parseContractSpec(wasm, { maxBytes: opts.maxWasmBytes ?? MAX_WASM_BYTES });
  if (spec.wasmHash !== result.wasmHash) {
    throw new RpcUnavailable(
      opts.rpcUrl,
      new Error(
        `Fetched WASM hash ${spec.wasmHash} does not match instance hash ${result.wasmHash}`,
      ),
    );
  }
  return spec;
}

interface InstanceRead {
  readonly server: SpecRpcServer;
  readonly result: WasmHashResult;
}

function createBoundedRpcServer(opts: FetchOptions): rpc.Server {
  const server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.allowHttp ?? false });
  server.httpClient.defaults.maxContentLength = maxRpcResponseBytes(
    opts.maxWasmBytes ?? MAX_WASM_BYTES,
  );
  return server;
}

async function readInstance(address: string, opts: FetchOptions): Promise<InstanceRead> {
  if (!StrKey.isValidContract(address)) {
    throw new TypeError(`Invalid contract address: ${address}`);
  }
  const server = opts.server ?? createBoundedRpcServer(opts);
  const footprint = new Contract(address).getFootprint();
  const response = await rpcCall(opts, () => server.getLedgerEntries(footprint));
  const entry = response.entries[0];
  if (!entry || !entry.val) {
    throw new ContractNotFound(address, opts.network);
  }
  const result = classifyInstance(entry.val, opts.rpcUrl);
  return { server, result: isExpired(entry, response.latestLedger) ? { ...result, archived: true } : result };
}

/**
 * An entry is live through the ledger in `liveUntilLedgerSeq` and expired from
 * the next one on. An entry with no TTL in the response is treated as live:
 * nothing says otherwise.
 */
function isExpired(entry: rpc.Api.LedgerEntryResult, latestLedger: number): boolean {
  return entry.liveUntilLedgerSeq !== undefined && entry.liveUntilLedgerSeq < latestLedger;
}

function classifyInstance(value: xdr.LedgerEntryData, rpcUrl: string): WasmHashResult {
  let executable: xdr.ContractExecutable;
  try {
    executable = value.contractData().val().instance().executable();
  } catch (cause) {
    throw new RpcUnavailable(rpcUrl, cause);
  }
  switch (executable.switch().name) {
    case 'contractExecutableWasm':
      return { type: 'wasm', wasmHash: executable.wasmHash().toString('hex') };
    case 'contractExecutableStellarAsset':
      return { type: 'stellar_asset' };
    default:
      throw new RpcUnavailable(
        rpcUrl,
        new TypeError(`Unsupported contract executable: ${executable.switch().name}`),
      );
  }
}

async function rpcCall<T>(opts: FetchOptions, work: () => Promise<T>): Promise<T> {
  const signal = opts.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  if (signal.aborted) {
    throw new RpcUnavailable(opts.rpcUrl, signal.reason);
  }
  try {
    return await withDeadline(work(), signal, opts.rpcUrl);
  } catch (cause) {
    if (isSpecReadError(cause)) {
      throw cause;
    }
    throw new RpcUnavailable(opts.rpcUrl, cause);
  }
}

function withDeadline<T>(work: Promise<T>, signal: AbortSignal, rpcUrl: string): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new RpcUnavailable(rpcUrl, signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {});
      reject(new RpcUnavailable(rpcUrl, signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}
