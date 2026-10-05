import { normalizeNetwork } from '@signet/types';
import { attributeContract } from '@/lib/contract-attribution';
import { loadOverviewSpec } from '@/lib/server/contract-overview-source';
import type { ContractSlotProps } from './slot-props';

/**
 * Props for a tab slot, or `null` when the contract is not attributed (the
 * layout has already 404'd or rendered its own unavailable state). The spec
 * lookup is request-cached, so the tabs and the Overview share it.
 */
export async function loadSlotProps(
  handle: string,
  address: string,
): Promise<ContractSlotProps | null> {
  const attribution = await attributeContract(handle, address);
  if (attribution.status !== 'attributed') return null;
  const network = normalizeNetwork(attribution.contract.network);
  const wasmHash = attribution.contract.wasmHash;
  const spec = await loadOverviewSpec({ address, network, wasmHash });
  return { handle, address, network, wasmHash, spec };
}
