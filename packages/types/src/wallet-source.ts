/**
 * Wallet provenance — the single source of truth for how a `Wallet.source`
 * value can read.
 *
 * A wallet binding can be attributed three ways: `curated` (seeded demo data),
 * `onchain` (attested via the Identity Registry's `claimed` event), or `cli`
 * (linked through the standalone CLI). The UI badge on the wallets dashboard
 * (`apps/web/app/(dashboard)/app/wallets/page.tsx`) and every write site
 * (`apps/indexer/src/workers/attestation.ts`, `apps/indexer/src/workers/seed.ts`)
 * derive from this list rather than repeating string literals, so a fourth
 * value can't be introduced in one place and forgotten in another.
 *
 * The CLI is a separate (Go) binary and can't import a TypeScript constant, so
 * this list is also the input to `scripts/generate-wallet-source-go.mjs`,
 * which regenerates `packages/types/generated/wallet_source.go`.
 * `scripts/check-wallet-source-go.mjs` fails CI if the generated file drifts
 * from this one — change this file first, then run
 * `node scripts/generate-wallet-source-go.mjs`, never hand-edit the `.go` file.
 */
export const WALLET_SOURCES = ['curated', 'onchain', 'cli'] as const;

export type WalletSource = (typeof WALLET_SOURCES)[number];

const WALLET_SOURCE_SET: ReadonlySet<string> = new Set(WALLET_SOURCES);

/** True when `value` is one of the allowed `Wallet.source` values. */
export function isWalletSource(value: string): value is WalletSource {
  return WALLET_SOURCE_SET.has(value);
}
