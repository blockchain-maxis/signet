import type { Network } from '@signet/types';
import type { SpecInput } from '@/lib/contract-overview';

/**
 * What every tab slot receives (#450): the contract's identity and the result
 * of `getContractSpec`, as a value (a decoded spec or a §1.5 failure) so a
 * slot never has to catch. `handle` is for building links to sibling tabs.
 */
export interface ContractSlotProps {
  handle: string;
  address: string;
  network: Network;
  /** Indexed WASM hash; `null` on the Horizon attribution path. */
  wasmHash: string | null;
  spec: SpecInput;
}
