/**
 * @file apps/web/lib/contract-provenance.ts
 *
 * Pure model for the provenance strip (#471, docs/CONTRACT_DOCS_DESIGN.md
 * §2.2): which WASM the docs were generated from and how a reader re-derives
 * the interface themselves.
 *
 * The strip adds only what the spec knows. The address, network and deploy tx
 * are the shell header's (#448) and are not repeated, except where a command
 * needs them. Every field is optional on its own: a fact the WASM did not
 * state is absent, never "unknown".
 */

import { buildProvenanceLine, type SpecInput } from './contract-overview.ts';
import { explorerFor } from './contract-header.ts';
import { stellarExpertContractUrl } from './network.ts';

export interface ProvenanceModel {
  /** Full lowercase hex SHA-256 of the WASM the docs describe. */
  wasmHash: string;
  /** `Built with Rust 1.91.1 · soroban-sdk 26.1.0`, or `null` when neither is stated. */
  built: string | null;
  /** `Targets protocol 23`, or `null` without `contractenvmetav0`. */
  protocol: string | null;
  /** `@stellar/stellar-sdk` version that read the interface; `null` when the spec does not carry one. */
  reader: { sdkVersion: string; extractedAt: string | null } | null;
  /** Stellar Expert page for the contract, on the contract's own network. */
  explorerUrl: string;
  /** The commands of the collapsible "Re-derive this" block, in order. */
  commands: string[];
}

/** The re-derive commands for one contract; `stellar contract fetch` writes binary, so it goes to a file. */
export function rederiveCommands(address: string, network: string, wasmHash: string): string[] {
  return [
    `stellar contract fetch --id ${address} --network ${network} --out-file contract.wasm`,
    `sha256sum contract.wasm   # expect ${wasmHash}`,
    'stellar contract info interface --wasm contract.wasm',
  ];
}

/**
 * @param opts.indexedWasmHash - the indexed hash, used when no spec was decoded
 *   (an interface that is absent or unreadable still has a WASM to re-derive from).
 * @param opts.extractedAt - when the stored spec was written, `null` when unknown.
 * @returns `null` when no WASM hash is known at all (contract not found,
 *   wrong network, RPC down): then there is nothing to state or re-derive.
 */
export function buildProvenanceModel(
  input: SpecInput,
  opts: {
    address: string;
    network: string;
    indexedWasmHash: string | null;
    extractedAt: Date | null;
  },
): ProvenanceModel | null {
  const spec = input.kind === 'spec' ? input.spec : null;
  const wasmHash = (spec?.wasmHash ?? opts.indexedWasmHash)?.toLowerCase() ?? null;
  if (!wasmHash) return null;

  const env = spec?.env;
  const preRelease = env && env.preRelease > 0 ? ` (pre-release ${env.preRelease})` : '';

  return {
    wasmHash,
    built: buildProvenanceLine(spec?.build),
    protocol: env ? `Targets protocol ${env.protocolVersion}${preRelease}` : null,
    reader: spec?.sdkVersion
      ? { sdkVersion: spec.sdkVersion, extractedAt: opts.extractedAt?.toISOString() ?? null }
      : null,
    explorerUrl: stellarExpertContractUrl(opts.address, explorerFor(opts.network)),
    commands: rederiveCommands(opts.address, opts.network, wasmHash),
  };
}

/** `2026-03-10 14:02 UTC`: fixed format and zone, so server and client render the same. */
export function formatExtractedAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
