// TODO(signet): wrap the Stellar Horizon API (account/operations history) used
// to discover deployments and activity for a linked wallet.

import type { IndexerConfig } from './config.js';

export function createHorizonClient(config: IndexerConfig) {
  // TODO(signet): return a real Horizon client (e.g. @stellar/stellar-sdk).
  return {
    baseUrl: config.horizonUrl,
  };
}
