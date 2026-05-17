// TODO(signet): wrap the Soroban RPC endpoint used to read contract state and
// resolve on-chain attestations from the identity-registry contract.

import type { IndexerConfig } from './config.js';

export function createSorobanRpcClient(config: IndexerConfig) {
  // TODO(signet): return a real Soroban RPC client.
  return {
    rpcUrl: config.sorobanRpcUrl,
  };
}
