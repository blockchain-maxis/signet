import { describeWalletSource, type WalletSourceDescriptor } from '@signet/types';

/** A provenance badge, ready to render: the shared descriptor plus its tone. */
export interface WalletSourceBadge extends WalletSourceDescriptor {
  /** Tailwind text-colour class. Stronger provenance reads brighter. */
  className: string;
  /** `marker` and `label` joined the way the badge shows them. */
  text: string;
}

/**
 * Colour per provenance. Only the presentation lives here - which sources
 * exist, and what each is called, comes from `@signet/types` so the dashboard
 * and any other surface cannot drift apart.
 */
const TONE: Record<WalletSourceDescriptor['source'], string> = {
  onchain: 'text-emerald-500',
  cli: 'text-sky-400',
  curated: 'text-[#5e5b51]',
  unknown: 'text-[#5e5b51]',
};

export function walletSourceBadge(source: unknown): WalletSourceBadge {
  const descriptor = describeWalletSource(source);
  return {
    ...descriptor,
    className: TONE[descriptor.source],
    text: `${descriptor.marker} ${descriptor.label}`,
  };
}
