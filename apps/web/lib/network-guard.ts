/**
 * Fail-fast guard against a network / endpoint mismatch.
 *
 * The configured Stellar network (`NEXT_PUBLIC_STELLAR_NETWORK`) selects the
 * transaction-signing passphrase, while the RPC and Horizon URLs are resolved
 * from their own env vars that each default to a *testnet* endpoint. Flip the
 * network to mainnet but forget one of the URL vars and the app signs with the
 * mainnet passphrase against a testnet endpoint — every transaction fails, in a
 * confusing way, with nothing pointing at the mismatch. This module catches that
 * at startup / first use instead.
 *
 * Mainnet Soroban RPC has no public SDF host (it is a paid/self-hosted provider
 * on an arbitrary domain), so we only flag the *unambiguous* SDF public hosts —
 * a custom mainnet RPC URL is left alone rather than false-flagged.
 */

export interface NetworkUrl {
  /** Env var name, for the error message (e.g. `SOROBAN_RPC_URL`). */
  label: string;
  /** The configured URL (may be empty/unset — skipped). */
  url: string;
}

/** True when `network` names Stellar mainnet (`mainnet` / `public` / `pubnet`). */
export function isMainnetNetwork(network: string): boolean {
  const n = network.trim().toLowerCase();
  return n === 'mainnet' || n === 'public' || n === 'pubnet';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** A URL that unambiguously points at Stellar *testnet* (or futurenet) infra. */
function isTestnetHost(url: string): boolean {
  const h = hostOf(url);
  return h.includes('testnet') || h.includes('futurenet');
}

/**
 * A URL that unambiguously points at Stellar *mainnet* SDF infra. Paid/self-hosted
 * mainnet RPC lives on arbitrary hosts we cannot classify, so those are NOT
 * flagged — only the SDF public hosts and any host that literally says mainnet.
 */
function isMainnetHost(url: string): boolean {
  const h = hostOf(url);
  if (!h || h.includes('testnet') || h.includes('futurenet')) return false;
  return (
    h === 'horizon.stellar.org' ||
    h === 'soroban.stellar.org' ||
    h === 'rpc.stellar.org' ||
    h.includes('mainnet') ||
    h.includes('pubnet')
  );
}

/**
 * Returns a human-readable description of a network/URL mismatch, or `null` when
 * the configured network and every URL agree.
 */
export function checkNetworkUrls(network: string, urls: NetworkUrl[]): string | null {
  const mainnet = isMainnetNetwork(network);
  const offenders: string[] = [];
  for (const { label, url } of urls) {
    if (!url) continue;
    if (mainnet && isTestnetHost(url)) {
      offenders.push(`${label} (${url}) points at Stellar testnet`);
    } else if (!mainnet && isMainnetHost(url)) {
      offenders.push(`${label} (${url}) points at Stellar mainnet`);
    }
  }
  if (offenders.length === 0) return null;

  const target = mainnet ? 'mainnet' : 'testnet';
  return (
    `Network/endpoint mismatch: configured network is "${network}" but ` +
    offenders.join('; ') +
    `. Transactions would be signed with the ${target} passphrase against the ` +
    `wrong network's endpoint and fail. Point the endpoint(s) at a ${target} host, ` +
    `or correct NEXT_PUBLIC_STELLAR_NETWORK.`
  );
}

/** Throws when the configured network and any RPC/Horizon URL disagree. */
export function assertNetworkUrls(network: string, urls: NetworkUrl[]): void {
  const message = checkNetworkUrls(network, urls);
  if (message) throw new Error(message);
}
