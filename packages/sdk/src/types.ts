// Deliberate public type surface for @signet/sdk.
//
// `@signet/types` is the shared, internal domain-type package consumed by
// every workspace (web, indexer, sdk, contracts tooling) — most of what it
// exports (handle-validation internals, `RESERVED_HANDLES`, the package's own
// `SIGNET_TYPES_VERSION` marker)
// exists for those internal consumers, not for SDK integrators. Blindly
// re-exporting all of it (`export *`) would make every one of those internal
// shapes part of this package's public npm contract, so a later internal
// refactor becomes a breaking change for external consumers who never asked
// for that shape in the first place.
//
// Only the types that actually appear in `SignetClient`'s method signatures
// are re-exported below. See `index.test.ts` for a regression test that
// fails if an internal export leaks back in.
export type { Handle, StellarAddress, RegistryEntry, RegistryCount } from '@signet/types';

import type { components, operations } from './generated/v1.ts';

/**
 * The v1 API's types, generated from `docs/api/openapi-v1.json` by
 * openapi-typescript (`pnpm --filter @signet/sdk generate`), so the SDK and the
 * API cannot drift.
 */
export type V1Schemas = components['schemas'];
export type V1Operations = operations;

/** The `data` of an operation's 200 response, by its OpenAPI `operationId`. */
export type V1Data<Op extends keyof operations> = operations[Op]['responses'] extends {
  200: { content: { 'application/json': { data: infer D } } };
}
  ? D
  : never;

/** The `meta` of an operation's 200 response, when it has one. */
export type V1Meta<Op extends keyof operations> = operations[Op]['responses'] extends {
  200: { content: { 'application/json': { meta: infer M } } };
}
  ? M
  : never;

/**
 * A profile as `GET /api/v1/profiles/{handle}` returns it. Since 0.1.0 this is
 * the v1 shape (`displayName`, `primaryWallet`, `wallets`, `counts`, …), not the
 * old tRPC `{ handle, profile, stats }`; see the README's migration note.
 */
export type ProfileResponse = V1Schemas['Profile'];
