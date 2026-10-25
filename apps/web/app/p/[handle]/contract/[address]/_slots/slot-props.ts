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
  /** Filter query (?q=, #503) */
  query?: string;
  /** Focused node ID (?focus=, #505) */
  focus?: string;
  /** Draw every callee instead of collapsing the rest (?callees=all, #543) */
  expandCallees?: boolean;
  /** Dim every function not seen writing (?writes=1, #512) */
  writesOnly?: boolean;
  /** Show the storage view (?storage=, #515); undefined is its default. */
  storage?: boolean;
  /** Function groups drawn expanded (?expand=pool,admin, #502), raw. */
  expand?: string;
  /** Activity range (?range=24h|7d|30d, #518), raw. */
  range?: string;
  /** Function order (?order=use ranks each group by observed use, #518). */
  order?: string;
}
