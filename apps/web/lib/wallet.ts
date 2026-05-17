// Stellar Wallets Kit initialization stub.
//
// We deliberately do NOT roll our own wallet adapter — Stellar Wallets Kit
// handles Freighter, xBull, Albedo, etc. It's a browser-only library, so it's
// loaded lazily here rather than imported at module scope.
//
// TODO(signet): construct StellarWalletsKit with the correct WalletNetwork
// (from STELLAR_NETWORK) and module list, expose connect/disconnect/sign
// helpers, and persist the selected wallet.

export async function createWalletKit(): Promise<unknown> {
  if (typeof window === 'undefined') {
    throw new Error('[wallet] createWalletKit() must run in the browser');
  }
  const kit = await import('@creit.tech/stellar-wallets-kit');
  // TODO(signet): return a configured StellarWalletsKit instance.
  return kit;
}
