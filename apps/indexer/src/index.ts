// Indexer entry point.
//
// For now this just boots, prints loaded config, and exits — no chain polling.
// TODO(signet): start the attestation/deployment/activity workers on an
// interval and keep the process alive.

import { loadConfig } from './config.js';

function main(): void {
  console.log('[indexer] starting...');

  const config = loadConfig();
  console.log('[indexer] config loaded:', {
    stellarNetwork: config.stellarNetwork,
    horizonUrl: config.horizonUrl,
    sorobanRpcUrl: config.sorobanRpcUrl,
    databaseUrl: config.databaseUrl ? '<set>' : '<unset>',
  });

  console.log('[indexer] no workers configured yet — exiting');
}

main();
