import Link from 'next/link';
import { SectionLabel } from '../../../_components/section-label';
import OperationsList from '../../../operations-list';
import { ExternalLink } from '../external-link';
import {
  getContractActivity,
  getContractOperationsPage,
  formatSnapshotTotal,
  type ContractActivitySnapshot,
} from '@/lib/contract-activity';
import { stellarExpertContractUrl } from '@/lib/network';
import { formatDate } from '@/lib/format-date';

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

interface ActivityPageProps {
  params: Promise<{ handle: string; address: string }>;
  searchParams: Promise<{ mine?: string }>;
}

function SnapshotStats({ snapshot }: { snapshot: ContractActivitySnapshot }) {
  const totalDisplay = formatSnapshotTotal(snapshot);

  return (
    <div>
      <div className="grid grid-cols-1 gap-px border border-[#1f1d19] bg-[#1f1d19] sm:grid-cols-3">
        <div className="flex flex-col justify-center bg-[#0a0908] px-6 py-6">
          <span
            className="text-[32px] font-bold leading-none tracking-[-0.025em] text-[#f5f4ee]"
            style={DISPLAY}
          >
            {snapshot.txCount24h}
          </span>
          <span
            className="mt-2 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
            style={MONO}
          >
            24h transactions
          </span>
        </div>

        <div className="flex flex-col justify-center bg-[#0a0908] px-6 py-6">
          <span
            className="text-[20px] font-bold leading-none tracking-[-0.025em] text-[#f5f4ee]"
            style={DISPLAY}
          >
            {totalDisplay}
          </span>
          <span
            className="mt-2 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
            style={MONO}
          >
            Total transactions
          </span>
        </div>

        <div className="flex flex-col justify-center bg-[#0a0908] px-6 py-6">
          <span
            className="text-[32px] font-bold leading-none tracking-[-0.025em] text-[#f5f4ee]"
            style={DISPLAY}
          >
            {snapshot.lastActivity ? formatDate(snapshot.lastActivity.toISOString()) : '—'}
          </span>
          <span
            className="mt-2 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
            style={MONO}
          >
            Last activity
          </span>
        </div>
      </div>
      <p
        className="mt-3 text-[11px] leading-[1.7] text-[#5e5b51]"
        style={MONO}
      >
        Snapshot as of {formatDate(snapshot.capturedAt.toISOString())}
      </p>
    </div>
  );
}

export default async function ActivityPage({ params, searchParams }: ActivityPageProps) {
  const { handle, address } = await params;
  const { mine } = await searchParams;
  const isMine = mine === '1';

  const query = new URLSearchParams({ offset: '0', limit: '25' });
  if (isMine) query.set('mine', '1');

  const [activity, opsResponse] = await Promise.all([
    getContractActivity(address),
    getContractOperationsPage(handle, address, query),
  ]);

  const endpoint = `/api/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/operations${isMine ? '?mine=1' : ''}`;
  const opsData = opsResponse.status === 200 ? opsResponse.body.data : [];
  const opsTotal = opsResponse.status === 200 ? opsResponse.body.meta.total : 0;
  const opsTruncated = opsResponse.status === 200 ? opsResponse.body.meta.truncated : false;
  const opsCap = opsResponse.status === 200 ? opsResponse.body.meta.cap : null;

  return (
    <section className="space-y-12">
      {/* On-chain activity stats */}
      <div>
        <SectionLabel as="h2">On-chain activity</SectionLabel>
        <div className="mt-6">
          {activity.source === 'none' ? (
            <div className="border border-[#1f1d19] bg-[#0e0d0b] px-5 py-6">
              <p
                className="text-[13px] leading-[1.7] text-[#8a8779]"
                style={MONO}
              >
                Activity is read from the indexer, which this deployment doesn't run.
              </p>
            </div>
          ) : !activity.snapshot ? (
            <div className="border border-[#1f1d19] bg-[#0e0d0b] px-5 py-6">
              <p
                className="text-[13px] leading-[1.7] text-[#8a8779]"
                style={MONO}
              >
                Not measured yet.
              </p>
            </div>
          ) : (
            <SnapshotStats snapshot={activity.snapshot} />
          )}
        </div>
      </div>

      {/* Recent calls */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <SectionLabel as="h2">Recent calls</SectionLabel>
          <Link
            href={
              isMine
                ? `/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/activity`
                : `/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/activity?mine=1`
            }
            scroll={false}
            className={`px-3 py-1.5 text-[11px] tracking-[0.05em] border transition-colors ${
              isMine
                ? 'border-[#e05a4b] bg-[#e05a4b]/10 text-[#f5f4ee]'
                : 'border-[#1f1d19] bg-[#0a0908] text-[#8a8779] hover:border-[#38352f] hover:text-[#f5f4ee]'
            }`}
            style={MONO}
          >
            {isMine ? `✓ Only @${handle}'s calls` : `Only @${handle}'s calls`}
          </Link>
        </div>

        <OperationsList
          handle={handle}
          initialOperations={opsData}
          total={opsTotal}
          truncated={opsTruncated}
          cap={opsCap}
          endpoint={endpoint}
          emptyState={
            <div className="bg-[#0e0d0b] px-5 py-6">
              <p
                className="text-[13px] leading-[1.7] text-[#b8b5a8]"
                style={MONO}
              >
                No captured calls yet.
              </p>
              <p
                className="mt-2 text-[12px] leading-[1.6] text-[#5e5b51]"
                style={MONO}
              >
                Capture only covers RPC's retention window since indexing began.
              </p>
            </div>
          }
        />
      </div>

      {/* Link to Stellar Expert */}
      <div className="pt-2">
        <ExternalLink
          href={stellarExpertContractUrl(address)}
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em] text-[#e05a4b] transition-colors hover:text-[#f0806f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]"
        >
          View full history on Stellar Expert ↗
        </ExternalLink>
      </div>
    </section>
  );
}
