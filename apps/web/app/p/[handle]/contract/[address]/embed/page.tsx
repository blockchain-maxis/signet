import { notFound } from 'next/navigation';
import { attributeContract } from '@/lib/contract-attribution';
import { ContractDiagram, loadSlotProps } from '../_slots';

export const dynamic = 'force-dynamic';

export interface EmbedPageProps {
  params: Promise<{ handle: string; address: string }>;
  searchParams: Promise<{ theme?: string }>;
}

/**
 * Embed mode for contract diagram (#520).
 *
 * Minimal standalone frame with no navigation, supporting ?theme=dark|light|auto,
 * and an attribution link pointing back to the full contract page.
 */
export default async function ContractEmbedPage({ params, searchParams }: EmbedPageProps) {
  const { handle, address } = await params;
  const { theme } = await searchParams;

  // Same 404 rule as the contract page
  const attribution = await attributeContract(handle, address);
  if (attribution.status === 'not-attributed' || attribution.status === 'invalid') {
    notFound();
  }
  if (attribution.status === 'unavailable') {
    throw new Error('contract attribution unavailable: indexer and Horizon unreachable');
  }

  const props = await loadSlotProps(handle, address);
  if (!props) {
    notFound();
  }

  const normalizedTheme = theme === 'dark' || theme === 'light' ? theme : 'auto';
  const vizTheme = normalizedTheme === 'auto' ? undefined : normalizedTheme;

  return (
    <div
      className="relative flex min-h-screen w-full flex-col justify-between p-6"
      data-viz-theme={vizTheme}
      style={{
        backgroundColor: 'var(--viz-ground, #0a0908)',
        color: 'var(--viz-node-text, #f5f4ee)',
      }}
    >
      <div className="flex-1">
        <ContractDiagram {...props} />
      </div>

      <footer className="mt-6 flex items-center justify-end border-t border-[#1f1d19] pt-3">
        <a
          href={`/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}`}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em] text-[#e05a4b] transition-colors hover:text-[#f0806f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          View on Signet &rarr;
        </a>
      </footer>
    </div>
  );
}
