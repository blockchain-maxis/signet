import type { SpecJson } from '@signet/spec';
import type { VersionSpecItem } from '@/lib/contract-changelog';
import { loadOverviewSpec, loadWasmVersions } from '@/lib/server/contract-overview-source';
import type { ContractSlotProps } from './slot-props';

/**
 * The spec for every WASM version recorded for a contract, newest first, for
 * the Functions tab's Changes section (#477). `undefined` when the contract
 * has one version or none. Only that tab loads it: reading old specs costs one
 * lookup per version, which the other tabs have no use for.
 */
export async function loadVersionSpecs({
  address,
  network,
  spec,
}: Pick<ContractSlotProps, 'address' | 'network' | 'spec'>): Promise<
  VersionSpecItem[] | undefined
> {
  const wasmVersions = await loadWasmVersions(address, network);
  if (wasmVersions.length <= 1) return undefined;

  // `loadContractSpec` always resolves a full `SpecJson`; `SpecInput` only
  // narrows it to the slice the overview reads, and the changelog diffs all of it.
  return Promise.all(
    wasmVersions.map(async (v, i): Promise<VersionSpecItem> => {
      const loaded =
        i === 0 && spec.kind === 'spec'
          ? spec
          : await loadOverviewSpec({ address, network, wasmHash: v.wasmHash });
      if (loaded.kind === 'spec') {
        return { wasmHash: v.wasmHash, observedAt: v.observedAt, spec: loaded.spec as SpecJson };
      }
      return { wasmHash: v.wasmHash, observedAt: v.observedAt, unretrievable: true };
    }),
  );
}
