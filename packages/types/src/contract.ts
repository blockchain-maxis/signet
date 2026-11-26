/**
 * @file Horizon function name constants and predicates for Soroban operations.
 *
 * Live Horizon prints Go XDR enum names, which prefix the type name twice
 * (e.g. `HostFunctionTypeHostFunctionTypeCreateContract` and
 * `HostFunctionTypeHostFunctionTypeCreateContractV2`).
 */

export const CREATE_CONTRACT_FUNCTIONS = [
  'HostFunctionTypeHostFunctionTypeCreateContract',
  'HostFunctionTypeHostFunctionTypeCreateContractV2',
  'HostFunctionTypeCreateContract',
  'HostFunctionTypeCreateContractV2',
] as const;

export type CreateContractFunction = (typeof CREATE_CONTRACT_FUNCTIONS)[number];

/**
 * Returns true when Horizon's `function` field indicates a contract deployment.
 * Accepts both the real double-prefixed Horizon strings and legacy single-prefix spellings.
 */
export function isCreateContractFunction(fn: string | undefined): boolean {
  if (!fn) return false;
  return (CREATE_CONTRACT_FUNCTIONS as readonly string[]).includes(fn);
}
