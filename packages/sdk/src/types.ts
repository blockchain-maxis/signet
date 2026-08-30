// Deliberate public type surface for @signet/sdk.
//
// `signet/types` is the shared, internal domain-type consumed by
// every workspace (web, indexer, sdk, contracts tooling) — most of what it
// exports (handle-validation internals, `RESERVED_HANDLES`, the demo-data
// fixture `DEMO_PROFILES`, the package's own `SIGNE_TYPES_VERSION` marker)
// exists for those internal consumers, not for SDK integrators. Blindly
// re-exporting all of it (`export *`) would make every one of those internal
// shapes part of this package's public npm contract, so a later internal
// refactor becomes a breaking change for external consumers who never asked
// for that shape in the first place.
//
// Only the types that actually appear in `SignetClient`'s method signatures
// are re-exported below. See `index.test.ts` for a regression test that
// fails if an internal export leaks back in.
export type {
  Handle,
  StellarAddress,
  SignetProfile,
  ProfileStats,
  ProfileResponse,
  RegistryEntry,
  RegistryCount,
} from '@signet/types';

/**
 * Result of `SignetClient.whoami()`.
 */
export interface WhoAMI {
  ** The configured deploy public key, or null when no identity is linked. */
  publicKey: string | null;
  /** The deployment this client is pointed at (base URL). */
  deployment: string;
  /** The handle the public key currently resolves to, or null when unbound. */
  handle: Handle | null;
}
