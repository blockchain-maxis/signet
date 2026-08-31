/**
 * Wallet provenance — how a handle ↔ wallet binding came to exist.
 *
 * The badge on a wallet is a claim about how much that binding is worth, so
 * every surface has to agree on the vocabulary. Rendering it from a string
 * comparison is what let a `cli` binding display as "curated": a
 * cryptographically proven link labelled as a hand-entered one. Anything that
 * shows provenance derives it from this module instead.
 */

/** Every provenance a wallet binding can have, strongest first. */
export const WALLET_SOURCES = ['onchain', 'cli', 'curated'] as const;

export type WalletSource = (typeof WALLET_SOURCES)[number];

/** What a surface needs to render one provenance. */
export interface WalletSourceDescriptor {
  /** The recognised source, or `'unknown'` for a value this build does not know. */
  source: WalletSource | 'unknown';
  /** Short glyph shown before the label. */
  marker: string;
  /** Human label. Never says "curated" about anything that is not. */
  label: string;
  /** One-line explanation, suitable for a tooltip. */
  description: string;
}

const DESCRIPTORS: Record<WalletSource, Omit<WalletSourceDescriptor, 'source'>> = {
  onchain: {
    marker: '●',
    label: 'on-chain',
    description: 'Attested through the on-chain Identity Registry.',
  },
  cli: {
    marker: '◆',
    label: 'CLI-linked',
    description: 'Proved by a signature from this wallet, linked through the CLI.',
  },
  curated: {
    marker: '○',
    label: 'curated',
    description: 'Recorded by hand, with no signature behind it.',
  },
};

/**
 * A value that is not one of {@link WALLET_SOURCES} - a newer source read from
 * a database an older build does not know about. It is deliberately not
 * described as curated: claiming an unknown provenance is a hand-entered one
 * is the bug this module exists to prevent.
 */
const UNKNOWN: WalletSourceDescriptor = {
  source: 'unknown',
  marker: '◌',
  label: 'unrecognised',
  description: 'This build does not know how this wallet was linked.',
};

/** Narrows an arbitrary value to a known {@link WalletSource}. */
export function isWalletSource(value: unknown): value is WalletSource {
  return typeof value === 'string' && (WALLET_SOURCES as readonly string[]).includes(value);
}

/** Everything a surface needs to render `source`, including the unknown case. */
export function describeWalletSource(source: unknown): WalletSourceDescriptor {
  if (!isWalletSource(source)) return UNKNOWN;
  return { source, ...DESCRIPTORS[source] };
}
