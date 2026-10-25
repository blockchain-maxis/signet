/**
 * @file The Diagram view's data (#580): the build's diagram, what it changed
 * against the deployed interface, read/write marks from this session's own
 * runs, and the A/B call trees side by side.
 *
 * Pure, so it is tested without a browser. Everything here comes from the
 * local `signet dev` API on 127.0.0.1 and stays on this machine: the marks
 * are labelled as local sandbox runs and are never mixed with chain
 * observations.
 */

import {
  classifyFunctions,
  describeMark,
  fromSpecJson,
  type ContractSpec,
  type TypeRef,
  type FootprintObservation,
  type MutabilityMark,
  type SpecJson,
} from '@signet/spec';
import {
  buildContractGraph,
  diffBadges,
  diffInterfaces,
  fromSandboxTrace,
  layoutContractGraph,
  renderDiagramSvg,
  type InterfaceDiff,
  type SandboxTrace,
} from '@signet/visualiser';
import type { DetailsData } from '@signet/visualiser/interactive/details';

/** One side's run in a cycle, with the trace the reloader asked for. */
export interface TracedRun {
  readonly result?: { readonly trace?: SandboxTrace };
}

export interface TracedOutcome {
  readonly name: string;
  readonly a: TracedRun;
  readonly b: TracedRun;
}

/** A stored spec's views even when its XDR entries do not decode. */
export function decodeSpec(json: SpecJson): ContractSpec {
  try {
    return fromSpecJson(json);
  } catch {
    return { ...json, entries: [] } as unknown as ContractSpec;
  }
}

/**
 * Marks for the build from its own runs: each outcome's B trace, read by
 * the same adapter (#542) and classifier (#510) as chain evidence, for the
 * session's contract only.
 */
export function localMarks(
  spec: ContractSpec,
  contract: string,
  outcomes: readonly TracedOutcome[],
): { marks: Record<string, MutabilityMark>; runs: number; seeded: boolean } {
  const observations: FootprintObservation[] = [];
  let runs = 0;
  let seeded = false;
  for (const o of outcomes) {
    const trace = o.b.result?.trace;
    if (!trace) continue;
    runs++;
    seeded ||= trace.seeded;
    for (const obs of fromSandboxTrace(trace).observations) {
      if (obs.contract === contract) observations.push(obs);
    }
  }
  const marks: Record<string, MutabilityMark> = {};
  for (const [name, mark] of classifyFunctions(spec, observations)) marks[name] = mark;
  return { marks, runs, seeded };
}

export interface DrawnBuild {
  readonly svg: string;
  readonly diff: InterfaceDiff | null;
  readonly runs: number;
}

/**
 * The build's diagram: its spec drawn by the web page's renderer, a badge on
 * each function or type it added or changed against the deployed interface,
 * and the local marks, labelled as such.
 */
export function drawBuild(input: {
  contract: string;
  local: SpecJson;
  deployed: SpecJson | null;
  outcomes: readonly TracedOutcome[];
}): DrawnBuild {
  const spec = decodeSpec(input.local);
  const model = layoutContractGraph(buildContractGraph(spec));
  const diff = input.deployed ? diffInterfaces(decodeSpec(input.deployed), spec) : null;
  const { marks, runs } = localMarks(spec, input.contract, input.outcomes);
  const svg = renderDiagramSvg(model, {
    idPrefix: 'dev-',
    hrefForNode: () => null,
    title: `${input.contract}: this build's interface`,
    ...(diff && { diff: diffBadges(diff) }),
    ...(runs > 0 && {
      overlays: {
        mutability: { marks, transactions: 0, firstLedger: null, lastLedger: null, sandboxRuns: runs, local: true },
      },
    }),
  });
  return { svg, diff, runs };
}

/** One frame as a row shows it. */
export interface FrameView {
  readonly contract: string;
  readonly function: string;
  /** The result's XDR, or the error. */
  readonly outcome: string;
  readonly failed: boolean;
}

export interface TraceRow {
  readonly index: number;
  readonly depth: number;
  readonly a: FrameView | null;
  readonly b: FrameView | null;
  /** Both sides ran this frame and it went differently, or only one did. */
  readonly differs: boolean;
}

function frameView(frame: SandboxTrace['frames'][number]): FrameView {
  return {
    contract: frame.contract,
    function: frame.function,
    outcome: frame.error ?? frame.result_xdr ?? 'no result',
    failed: frame.error !== null,
  };
}

/**
 * The A and B call trees row by row, frame index against frame index. With
 * one side only (a plain call), nothing differs.
 */
export function traceRows(a: SandboxTrace | null | undefined, b: SandboxTrace | null | undefined): TraceRow[] {
  const n = Math.max(a?.frames.length ?? 0, b?.frames.length ?? 0);
  const both = Boolean(a && b);
  const rows: TraceRow[] = [];
  for (let i = 0; i < n; i++) {
    const fa = a?.frames[i];
    const fb = b?.frames[i];
    const va = fa ? frameView(fa) : null;
    const vb = fb ? frameView(fb) : null;
    const differs =
      both &&
      (!va ||
        !vb ||
        va.contract !== vb.contract ||
        va.function !== vb.function ||
        va.outcome !== vb.outcome);
    rows.push({ index: i, depth: (fb ?? fa)!.depth, a: va, b: vb, differs });
  }
  return rows;
}

/** The truncation notice, when a side's trace hit its frame cap. */
export function truncationNotice(trace: SandboxTrace | null | undefined): string | null {
  if (!trace?.truncated) return null;
  return `Trace truncated: ${trace.frame_count} frames ran, the first ${trace.max_frames} are shown.`;
}

/** The trace's storage, by contract: what each one read and wrote. */
export function storageRows(
  trace: SandboxTrace | null | undefined,
): { contract: string; reads: number; writes: number; changed: number }[] {
  return (trace?.storage ?? []).map((s) => ({
    contract: s.contract ?? 'no contract (accounts, code)',
    reads: s.read_only.length,
    writes: s.read_write.length,
    changed: s.changed.length,
  }));
}

/** A type as Rust-ish text: `Option<Vec<Address>>`. */
export function typeText(t: TypeRef): string {
  if (typeof t === 'string') return t;
  switch (t.type) {
    case 'named':
      return t.name;
    case 'option':
      return `Option<${typeText(t.value)}>`;
    case 'vec':
      return `Vec<${typeText(t.element)}>`;
    case 'map':
      return `Map<${typeText(t.key)}, ${typeText(t.value)}>`;
    case 'result':
      return `Result<${typeText(t.ok)}, ${typeText(t.error)}>`;
    case 'tuple':
      return `(${t.elements.map(typeText).join(', ')})`;
    case 'bytes_n':
      return `BytesN<${t.n}>`;
    default:
      return t.xdrArm;
  }
}

/** The detail card's data (#500) for the build's functions, with what this session saw them do. */
export function buildDetails(
  spec: ContractSpec,
  marks: Readonly<Record<string, MutabilityMark>>,
  diff: InterfaceDiff | null,
): DetailsData {
  const out: DetailsData = {};
  for (const f of spec.functions) {
    const id = `fn:${f.name}`;
    const outputs = f.outputs.length ? ` -> ${f.outputs.map(typeText).join(', ')}` : '';
    const notes: string[] = [];
    const mark = marks[f.name];
    if (mark) notes.push(`${describeMark(mark)} (local sandbox)`);
    if (diff?.added.includes(id)) notes.push('added in this build');
    if (diff?.changed.includes(id)) notes.push('signature changed in this build');
    out[id] = {
      signature: `${f.name}(${f.inputs.map((i) => `${i.name}: ${typeText(i.type)}`).join(', ')})${outputs}`,
      ...(f.doc && { doc: f.doc }),
      ...(notes.length && { marks: notes }),
    };
  }
  return out;
}
