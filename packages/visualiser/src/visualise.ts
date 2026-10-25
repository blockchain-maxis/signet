/**
 * @file One call from a `SpecJson` to a finished SVG (#544).
 *
 * The Go CLI cannot run TypeScript, and a second layout written in Go would
 * drift from this one, so the CLI embeds one JS bundle of this package and
 * calls `globalThis.signetVisualise` (`scripts/build-cli-bundle.mts`). The
 * CLI gets the spec as `SpecJson` from `signet-simulator`'s `spec_extract`
 * (#545), so the bundle never parses WASM.
 *
 * The pipeline is the contract page's: spec, graph, layout, then the
 * worth-drawing decision. A `draw` decision renders the laid-out model; a
 * `too-simple` or `too-large` one renders the function list, column 0 alone,
 * as the page falls back to. The output is the self-contained standalone
 * SVG (#506), which needs no stylesheet. Synchronous and pure.
 */

import { fromSpecJson, type SpecJson } from '@signet/spec';
import { diagramDecision, type DiagramDecision } from './decide.ts';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph, type LayoutOverlays, type PositionedDiagramModel } from './layout.ts';
import { renderStandaloneSvg } from './render.ts';
import type { CallGraphOverlay } from './observe/call-graph.ts';
import type { VizTheme } from './tokens.ts';

export interface VisualiseInput {
  readonly specJson: SpecJson;
  readonly theme: VizTheme | 'auto';
  /** For the footer: the contract the spec was read from. */
  readonly address?: string;
  readonly network?: string;
  /** The call graph overlay (#543), with plain-object labels by address. */
  readonly overlays?: {
    readonly calls?: {
      readonly overlay: CallGraphOverlay;
      readonly labels?: Readonly<Record<string, string>>;
      readonly expand?: boolean;
    };
  };
}

export interface VisualiseOutput {
  readonly svg: string;
  readonly decision: DiagramDecision;
  readonly wasmHash: string;
}

/** The function list the page shows when the graph is not worth drawing. */
function listModel(model: PositionedDiagramModel): PositionedDiagramModel {
  return {
    ...model,
    nodes: model.nodes.filter((n) => n.kind === 'function'),
    edges: [],
    groups: [],
  };
}

export function visualise(input: VisualiseInput): VisualiseOutput {
  const spec = fromSpecJson(input.specJson);
  const graph = buildContractGraph(spec);
  const calls = input.overlays?.calls;
  const overlays: LayoutOverlays = calls
    ? {
        calls: {
          overlay: calls.overlay,
          ...(calls.labels && { labels: new Map(Object.entries(calls.labels)) }),
          ...(calls.expand !== undefined && { expand: calls.expand }),
        },
      }
    : {};
  const model = layoutContractGraph(graph, {}, overlays);
  const decision = diagramDecision(graph, layoutContractGraph(graph));
  const svg = renderStandaloneSvg(decision.kind === 'draw' ? model : listModel(model), {
    theme: input.theme,
    provenance: {
      address: input.address ?? '',
      network: input.network ?? '',
      wasmHash: spec.wasmHash,
    },
  });
  return { svg, decision, wasmHash: spec.wasmHash };
}
