'use client';

/**
 * Stellar Wallets Kit integration (v2).
 *
 * Wraps `@creit.tech/stellar-wallets-kit` (Freighter, xBull, Albedo, …) behind
 * a small, lazily-loaded API. The kit is browser-only, so it is imported and
 * initialised on first use rather than at module scope — this keeps it out of
 * the server bundle and avoids SSR crashes.
 *
 * v2 exposes `StellarWalletsKit` as a *static* class configured once via
 * `init(...)`, so we guard initialisation behind `ensureInit()` and call the
 * static methods directly.
 */

const NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet').toLowerCase();
const IS_MAINNET = NETWORK === 'mainnet' || NETWORK === 'public';

export const NETWORK_PASSPHRASE = IS_MAINNET
  ? 'Public Global Stellar Network ; September 2015'
  : 'Test SDF Network ; September 2015';

const STORAGE_KEY = 'signet:wallet-id';

// Resolved once: dynamically import the kit, register the default wallet
// modules, and set the network. Subsequent calls reuse the same promise.
let initPromise: Promise<typeof import('@creit.tech/stellar-wallets-kit').StellarWalletsKit> | null =
  null;

async function ensureInit() {
  if (typeof window === 'undefined') {
    throw new Error('[wallet] wallet kit is browser-only');
  }
  if (!initPromise) {
    initPromise = (async () => {
      const { StellarWalletsKit, Networks } = await import('@creit.tech/stellar-wallets-kit');
      const { defaultModules } = await import('@creit.tech/stellar-wallets-kit/modules/utils');
      StellarWalletsKit.init({
        modules: defaultModules(),
        network: IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET,
      });
      return StellarWalletsKit;
    })();
  }
  return initPromise;
}

/** Open the wallet-selection modal and return the connected G… address. */
export async function connectWallet(): Promise<string> {
  const kit = await ensureInit();
  const { address } = await kit.authModal();
  // Persist the user's choice so we can restore the session on reload.
  const id = kit.selectedModule?.productId;
  if (id) window.localStorage.setItem(STORAGE_KEY, id);
  return address;
}

/** Restore a previously-selected wallet and return its address, if any. */
export async function getConnectedAddress(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) return null;
  try {
    const kit = await ensureInit();
    kit.setWallet(id);
    // `fetchAddress` re-reads from the wallet module (needed after a reload,
    // when the in-memory address is empty).
    const { address } = await kit.fetchAddress();
    return address;
  } catch {
    return null;
  }
}

export async function disconnectWallet(): Promise<void> {
  window.localStorage.removeItem(STORAGE_KEY);
  try {
    const kit = await ensureInit();
    await kit.disconnect();
  } catch {
    /* already disconnected */
  }
}

/** Sign a base64 transaction envelope with the connected wallet. */
export async function signTransaction(xdr: string, address: string): Promise<string> {
  const kit = await ensureInit();
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  return signedTxXdr;
}

/** Sign an arbitrary message; returns the base64 signature. */
export async function signMessage(message: string, address: string): Promise<string> {
  const kit = await ensureInit();
  const { signedMessage } = await kit.signMessage(message, { address });
  return signedMessage;
}

/**
 * Sign-in via SEP-10 Stellar Web Authentication: connect (if needed), fetch a
 * challenge transaction from `/api/auth/sep10`, sign it with the wallet, and
 * exchange it for a session cookie. Returns the authenticated address.
 *
 * The older custom message-signing flow (`/api/auth/{challenge,verify}`)
 * still exists server-side for any client mid-migration to this one, but the
 * app's own UI goes through SEP-10 exclusively now.
 */
export async function signIn(): Promise<string> {
  const address = (await getConnectedAddress()) ?? (await connectWallet());

  const chalRes = await fetch(`/api/auth/sep10?account=${encodeURIComponent(address)}`);
  if (!chalRes.ok) throw new Error('Could not start sign-in');
  const { transaction } = (await chalRes.json()) as { transaction: string };

  const signedTransaction = await signTransaction(transaction, address);

  const verifyRes = await fetch('/api/auth/sep10', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction: signedTransaction }),
  });
  if (!verifyRes.ok) {
    const { error } = (await verifyRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(error ?? 'Sign-in verification failed');
  }
  return address;
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  await disconnectWallet();
}

/**
 * Sign this wallet out of every *other* device, keeping this one signed in.
 * Throws with the server's message so the caller can show why nothing changed
 * — a revocation that silently failed is the one failure mode worth surfacing.
 */
export async function signOutOtherSessions(): Promise<void> {
  const res = await fetch('/api/auth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'others' }),
  });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error ?? 'Could not sign out your other devices');
  }
}
