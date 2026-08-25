/**
 * Fail-fast guard against a network / endpoint mismatch (indexer side).
 *
 * `INDEXER_NETWORK` selects the network the indexer reads, while
 * `INDEXER_RPC_URL` / `INDEXER_HORIZON_URL` each default to a *testnet* endpoint.
 * Set the network to mainnet but leave a URL var unset and the indexer reads the
 * wrong chain — silently, with no error pointing at the mismatch. This catches it
 * at startup.
 *
 * Mainnet Soroban RPC has no public SDF host (paid/self-hosted on an arbitrary
 * domain), so only the unambiguous SDF public hosts are flagged; a custom
 * mainnet RPC URL is left alone rather than false-flagged.
 *
 * Mirrors apps/web/lib/network-guard.ts — kept per-package so the two independent
 * runtimes stay decoupled.
 */

export interface NetworkUrl {
  /** Env var name, for the error message (e.g. `INDEXER_RPC_URL`). */
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
    `Network/endpoint mismatch: INDEXER_NETWORK is "${network}" but ` +
    offenders.join('; ') +
    `. The indexer would read the wrong chain. Point the endpoint(s) at a ` +
    `${target} host, or correct INDEXER_NETWORK.`
  );
}

/** Throws when the configured network and any RPC/Horizon URL disagree. */
export function assertNetworkUrls(network: string, urls: NetworkUrl[]): void {
  const message = checkNetworkUrls(network, urls);
  if (message) throw new Error(message);
}
