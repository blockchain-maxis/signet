/**
 * @file apps/web/lib/contract-header.ts
 *
 * Pure presentation model for the contract header (#448, design §2.2): which
 * contract this page describes and which WASM it describes, so a reader can
 * check both.
 *
 * The WASM hash is the one field with two possible sources. The indexed
 * `Contract.wasmHash` is a snapshot; an upgrade changes the hash without
 * changing the address, so the live instance read (`fetchWasmHash`, #433) wins
 * whenever it is available, and every state says where its hash came from.
 * The field is never blank: with neither source it says so.
 *
 * Pure (no env, no network) so the labelling rules are unit-testable; the
 * configured network is passed in rather than imported.
 */

import type { AttributedContract } from './contract-attribution.ts';
import { formatDate } from './format-date.ts';
import { stellarExpertAccountUrl, stellarExpertContractUrl, stellarExpertTxUrl } from './network.ts';

export type WasmHashState = 'live' | 'indexed' | 'unavailable';

export interface HeaderModel {
  address: string;
  addressUrl: string;
  network: {
    /** Canonical network id as stored on the contract row. */
    value: string;
    /** True when the row's network is not the configured one. */
    mismatch: boolean;
    /** Sentence shown with a mismatch, otherwise null. */
    note: string | null;
  };
  wasm: {
    state: WasmHashState;
    /** The hash shown, or null when neither source has one. */
    hash: string | null;
    /** Where the hash came from. */
    label: string;
    /** Set only when the live hash differs from the indexed one. */
    note: string | null;
  };
  deployTx: { hash: string; url: string };
  /** Formatted deployment date, e.g. "1 Mar 2026". */
  deployedOn: string;
  deployer: { pubkey: string; display: string; url: string };
  handle: string;
}

/** Stellar Expert path segment for a contract's own network (not the configured one). */
export function explorerFor(network: string): string {
  return network === 'mainnet' ? 'public' : 'testnet';
}

export function truncateMiddle(value: string, head: number, tail: number): string {
  return value.length <= head + tail + 3 ? value : `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function wasmField(
  indexed: string | null,
  live: string | null,
  indexedAsOf: string | null,
): HeaderModel['wasm'] {
  const asOf = indexedAsOf ? `as of ${formatDate(indexedAsOf)}` : 'as last indexed';
  if (live) {
    const upgraded = indexed !== null && indexed.toLowerCase() !== live.toLowerCase();
    return {
      state: 'live',
      hash: live,
      label: 'current, read from ledger',
      note: upgraded
        ? `Upgraded since indexing: the index recorded ${truncateMiddle(indexed, 8, 8)} ${asOf}.`
        : null,
    };
  }
  if (indexed) return { state: 'indexed', hash: indexed, label: asOf, note: null };
  return { state: 'unavailable', hash: null, label: 'unavailable (RPC unreachable)', note: null };
}

/**
 * @param attributed - the attributed contract (indexed row or Horizon result).
 * @param liveWasmHash - hash read from the live instance entry, `null` when the
 *   read failed or the executable has no WASM (Stellar Asset Contract).
 * @param opts.handle - the handle the contract is attributed to.
 * @param opts.configuredNetwork - the network this deployment serves.
 * @param opts.indexedAsOf - ISO time the indexed hash was last checked.
 */
export function buildHeaderModel(
  attributed: AttributedContract,
  liveWasmHash: string | null,
  opts: { handle: string; configuredNetwork: string; indexedAsOf?: string | null },
): HeaderModel {
  const explorer = explorerFor(attributed.network);
  const mismatch = attributed.network !== opts.configuredNetwork;
  return {
    address: attributed.address,
    addressUrl: stellarExpertContractUrl(attributed.address, explorer),
    network: {
      value: attributed.network,
      mismatch,
      note: mismatch
        ? `This contract is on ${attributed.network}, but this deployment serves ${opts.configuredNetwork}.`
        : null,
    },
    wasm: wasmField(attributed.wasmHash, liveWasmHash, opts.indexedAsOf ?? null),
    deployTx: {
      hash: attributed.deployTxHash,
      url: stellarExpertTxUrl(attributed.deployTxHash, explorer),
    },
    deployedOn: formatDate(attributed.deployedAt),
    deployer: {
      pubkey: attributed.deployerPubkey,
      display: truncateMiddle(attributed.deployerPubkey, 8, 6),
      url: stellarExpertAccountUrl(attributed.deployerPubkey, explorer),
    },
    handle: opts.handle,
  };
}
