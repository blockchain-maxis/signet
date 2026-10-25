/**
 * Local sandbox runs as visualiser evidence (#542, design §1.4).
 *
 * `signet-simulator` returns a call trace with a `simulate` that asks for one
 * (#541): the call tree the host actually ran, with arguments and results,
 * and the footprint by contract. It is the richest evidence the visualiser
 * gets — it can exercise functions nobody has called on-chain — and it stays
 * on the developer's machine (CONTRACT_SANDBOX_DESIGN.md §3.2).
 *
 * `fromSandboxTrace` turns one trace into the same `FootprintObservation`s
 * a transaction capture normalises into (`source: 'sandbox'`, with the run's
 * `seeded` flag, so the mutability classifier keeps seeded runs from
 * outweighing chain evidence), and passes the call tree through for the
 * cross-contract graph (#516, #543).
 *
 * The trace format is versioned and this adapter reads exactly the versions
 * it knows: anything else throws `UnsupportedTraceVersionError` rather than
 * being guessed at.
 *
 * Pure: plain data in, plain data out.
 */

import { normaliseFootprint, type FootprintObservation } from '@signet/spec';

/** The trace versions (`sandbox/protocol/schema/v1/trace.json`) this visualiser reads. */
export const SUPPORTED_TRACE_VERSIONS: readonly number[] = [1];

/** One contract call in a trace, as `trace.json` v1 defines it. */
export interface SandboxTraceFrame {
  readonly index: number;
  readonly parent: number | null;
  readonly depth: number;
  readonly contract: string;
  readonly function: string;
  /** null for a Stellar asset contract, which runs no WASM. */
  readonly wasm_hash: string | null;
  readonly args_xdr: readonly string[];
  readonly args_exact: boolean;
  readonly result_xdr: string | null;
  readonly error: string | null;
}

/** One contract's share of the footprint; `contract: null` holds keys of no contract. */
export interface SandboxTraceStorage {
  readonly contract: string | null;
  readonly read_only: readonly string[];
  readonly read_write: readonly string[];
  readonly changed: readonly string[];
}

/** A `simulate` call trace (`trace.json`). */
export interface SandboxTrace {
  readonly version: number;
  readonly source: string;
  readonly ledger: number;
  readonly seeded: boolean;
  readonly frames: readonly SandboxTraceFrame[];
  readonly frame_count: number;
  readonly max_frames: number;
  readonly truncated: boolean;
  readonly storage: readonly SandboxTraceStorage[];
}

/** A call and the calls it made, in order. */
export interface CallNode {
  readonly contract: string;
  readonly function: string;
  readonly wasmHash: string | null;
  readonly argsXdr: readonly string[];
  /** False when the arguments' split is a guess (no spec said). */
  readonly argsExact: boolean;
  /** The returned `ScVal`, base64 XDR; null when the call failed. */
  readonly resultXdr: string | null;
  readonly error: string | null;
  readonly children: readonly CallNode[];
}

export interface SandboxEvidence {
  readonly observations: FootprintObservation[];
  readonly callTree: CallNode[];
  /** The trace held only its first frames; the tree is incomplete. */
  readonly truncated: boolean;
}

export class UnsupportedTraceVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(
      `trace schema v${String(version)} not supported by this visualiser (supports ${SUPPORTED_TRACE_VERSIONS.join(', ')})`,
    );
    this.name = 'UnsupportedTraceVersionError';
    this.version = version;
  }
}

/**
 * One observation per contract the run touched, and the call tree.
 *
 * - A contract's function is the one its frames ran; a contract entered with
 *   more than one function gets `null`, as a transaction's sub-call would.
 * - Keys of no one contract (code, accounts, auth nonces) go with the root
 *   contract, whose invocation reached them — the attribution a transaction
 *   capture makes for its whole footprint.
 * - A contract that ran no WASM (a Stellar asset contract) has no spec to
 *   mark, so it gives no observation; it is still in the call tree.
 * - An observation is successful when every call into that contract
 *   returned. The simulator's changes are what a transaction's meta would
 *   report, so `changed` is always set.
 */
export function fromSandboxTrace(trace: SandboxTrace): SandboxEvidence {
  if (!SUPPORTED_TRACE_VERSIONS.includes(trace.version)) {
    throw new UnsupportedTraceVersionError(trace.version);
  }
  const root = trace.frames[0];
  const unowned = trace.storage.find((s) => s.contract === null);

  const observations: FootprintObservation[] = [];
  for (const group of trace.storage) {
    if (group.contract === null) continue;
    const contract = group.contract;
    const frames = trace.frames.filter((f) => f.contract === contract);
    const wasmHash = frames.find((f) => f.wasm_hash !== null)?.wasm_hash ?? null;
    if (wasmHash === null) continue;
    const functions = new Set(frames.map((f) => f.function));
    const extra = root?.contract === contract && unowned ? unowned : null;
    observations.push(
      normaliseFootprint({
        contract,
        function: functions.size === 1 ? [...functions][0]! : null,
        source: 'sandbox',
        ledger: trace.ledger,
        sandboxRun: { seeded: trace.seeded, wasmHash },
        wasmHash,
        readOnly: [...group.read_only, ...(extra?.read_only ?? [])],
        readWrite: [...group.read_write, ...(extra?.read_write ?? [])],
        changed: [...group.changed, ...(extra?.changed ?? [])],
        successful: frames.length > 0 && frames.every((f) => f.error === null),
      }),
    );
  }
  return { observations, callTree: callTree(trace.frames), truncated: trace.truncated };
}

/** Frames (in call order, parents first) as a forest. */
function callTree(frames: readonly SandboxTraceFrame[]): CallNode[] {
  const children = new Map<number | null, SandboxTraceFrame[]>();
  for (const frame of frames) {
    const siblings = children.get(frame.parent) ?? [];
    siblings.push(frame);
    children.set(frame.parent, siblings);
  }
  const node = (frame: SandboxTraceFrame): CallNode => ({
    contract: frame.contract,
    function: frame.function,
    wasmHash: frame.wasm_hash,
    argsXdr: frame.args_xdr,
    argsExact: frame.args_exact,
    resultXdr: frame.result_xdr,
    error: frame.error,
    children: (children.get(frame.index) ?? []).map(node),
  });
  return (children.get(null) ?? []).map(node);
}
