// Deliberate public type surface for @signet/sdk.
//
// The handful of domain types the client's signatures use are declared here,
// not re-exported from the internal `@signet/types` package: that package is
// private to the monorepo, so a published `.d.ts` that imported it would not
// resolve for anyone outside it, and re-exporting it would make its internal
// shapes part of this package's public contract. `index.test.ts` fails if an
// internal export leaks in.

/** A Signet handle: lowercase, `/^[a-z0-9_-]{1,32}$/`. */
export type Handle = string;

/** A Stellar account or contract address (G… / C…). */
export type StellarAddress = string;

/** A single handle ↔ wallet binding from the on-chain registry. */
export interface RegistryEntry {
  handle: Handle;
  wallet: StellarAddress;
}

/** The registry's binding counter. */
export interface RegistryCount {
  count: number;
}

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
