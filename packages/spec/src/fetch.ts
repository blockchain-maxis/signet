/**
 * @file @signet/spec
 *
 * Network half of the spec reader: fetches a deployed contract's instance entry
 * and WASM bytecode over Soroban RPC (§1.2 and §5 of docs/CONTRACT_DOCS_DESIGN.md).
 *
 * Node-only: published through the separate `@signet/spec/fetch` export path so
 * the browser-safe `@signet/spec` surface stays free of network access.
 */

import { Contract, contract, hash, rpc, StrKey } from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';
import type { Network } from '@signet/types';
import {
  ContractNotFound,
  InterfaceUnreadable,
  InvalidWasm,
  NoInterface,
  RpcUnavailable,
  isSpecReadError,
} from './errors.ts';
import type { ContractSpec } from './types.ts';

/** Custom WASM section that carries the contract's interface specification. */
const CONTRACT_SPEC_SECTION = 'contractspecv0';

/** Default deadline for a single fetch; callers override it through `opts.signal`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Version of `@stellar/stellar-sdk` used to decode fetched specs.
 *
 * TODO(#424): temporary inlined constant. Replace with `parseContractSpec` from
 * `./parse.ts` and `STELLAR_SDK_VERSION` from `./sdk-version.ts` once #424 lands.
 */
const DECODE_SDK_VERSION = '16.1.0';

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
  /** Injected `rpc.Server`-shaped client (tests); a real `rpc.Server` otherwise. */
  readonly server?: SpecRpcServer;
}

/**
 * Result of reading a contract's instance executable.
 */
export type WasmHashResult =
  | { readonly type: 'wasm'; readonly wasmHash: string }
  | { readonly type: 'stellar_asset' };

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
 *   `InvalidWasm` for a non-WASM module, `InterfaceUnreadable` when the spec
 *   section cannot be decoded by this SDK version, `ContractNotFound` when the
 *   instance entry is missing, `RpcUnavailable` for transport failures or an
 *   inconsistent endpoint response.
 */
export async function fetchContractSpec(
  address: string,
  opts: FetchOptions,
): Promise<ContractSpec> {
  const { server, result } = await readInstance(address, opts);
  if (result.type === 'stellar_asset') {
    throw new NoInterface('stellar_asset_contract');
  }
  const wasm = await rpcCall(opts, () => server.getContractWasmByContractId(address));
  const spec = decodeWasm(wasm);
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

async function readInstance(address: string, opts: FetchOptions): Promise<InstanceRead> {
  if (!StrKey.isValidContract(address)) {
    throw new TypeError(`Invalid contract address: ${address}`);
  }
  const server = opts.server ?? new rpc.Server(opts.rpcUrl, { allowHttp: opts.allowHttp ?? false });
  const footprint = new Contract(address).getFootprint();
  const response = await rpcCall(opts, () => server.getLedgerEntries(footprint));
  const entry = response.entries[0];
  if (!entry || !entry.val) {
    throw new ContractNotFound(address, opts.network);
  }
  return { server, result: classifyInstance(entry.val, opts.rpcUrl) };
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

/**
 * Decode fetched WASM bytes into a `ContractSpec`.
 *
 * TODO(#424): inlined stopgap for `parseContractSpec(wasm)` from `./parse.ts`;
 * flattened `functions`/`types`/`errors`/`events` fill in with that swap.
 */
function decodeWasm(wasm: Buffer): ContractSpec {
  let section: ArrayBuffer | undefined;
  try {
    section = WebAssembly.Module.customSections(
      new WebAssembly.Module(Uint8Array.from(wasm)),
      CONTRACT_SPEC_SECTION,
    )[0];
  } catch (cause) {
    throw new InvalidWasm(cause);
  }
  if (section === undefined) {
    throw new NoInterface('no_section');
  }
  const bytes = Buffer.from(section);
  if (bytes.length === 0) {
    throw new NoInterface('empty_section');
  }
  let spec: contract.Spec;
  try {
    spec = new contract.Spec(bytes);
  } catch (cause) {
    throw new InterfaceUnreadable(DECODE_SDK_VERSION, cause);
  }
  return {
    wasmHash: hash(wasm).toString('hex'),
    entries: spec.entries,
    spec,
    functions: [],
    types: [],
    errors: [],
    events: [],
    sdkVersion: DECODE_SDK_VERSION,
  };
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
