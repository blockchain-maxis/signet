import Link from 'next/link';
import { normalizeNetwork } from '@signet/types';
import { attributeContract } from '@/lib/contract-attribution';
import {
  summariseActivity,
  summariseSpec,
  type ActivitySummary,
  type FailureCopy,
  type InterfaceSummary,
} from '@/lib/contract-overview';
import { contractTabSegmentHref } from '@/lib/contract-tabs';
import { loadLatestSnapshot, loadOverviewSpec } from '@/lib/server/contract-overview-source';
import { SectionLabel } from '../../_components/section-label';

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

const LINK_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

const TEXT_LINK = `text-[10px] uppercase tracking-[0.2em] text-[#e05a4b] transition-colors hover:text-[#f0806f] ${LINK_FOCUS}`;

function Count({ n, label, href }: { n: number; label: string; href: string }) {
  return (
    <Link
      href={href}
      className={`group block px-5 py-5 transition-colors hover:bg-[#12100d] ${LINK_FOCUS}`}
    >
      <span
        className="block text-[40px] font-bold leading-none tracking-[-0.025em] text-[#f5f4ee] tabular-nums"
        style={DISPLAY}
      >
        {n}
      </span>
      <span
        className="mt-3 block text-[10px] uppercase tracking-[0.22em] text-[#8a8779] transition-colors group-hover:text-[#f5f4ee]"
        style={MONO}
      >
        {label}
      </span>
    </Link>
  );
}

function InterfaceBlock({
  summary,
  hrefs,
}: {
  summary: InterfaceSummary;
  hrefs: { functions: string; types: string };
}) {
  // The noun alone is the label; the number is the figure above it.
  const noun = (label: string) => label.replace(/^\d+ /, '');
  return (
    <div>
      <div className="grid grid-cols-1 divide-y divide-[#1f1d19] border border-[#1f1d19] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Count
          n={summary.functionCount}
          label={noun(summary.functionsLabel)}
          href={hrefs.functions}
        />
        <Count n={summary.typeCount} label={noun(summary.typesLabel)} href={hrefs.types} />
        {/* Error cases are documented on the Types tab, under #error-{name}. */}
        <Count n={summary.errorCount} label={noun(summary.errorsLabel)} href={hrefs.types} />
      </div>
      {summary.coverage && (
        <p className="mt-4 text-[13px] leading-[1.7] text-[#b8b5a8]" style={MONO}>
          {summary.coverage}
        </p>
      )}
    </div>
  );
}

function FailureBlock({ failure }: { failure: FailureCopy }) {
  return (
    <div className="border-l-2 border-[#8b1a1a] pl-5" data-testid={`overview-${failure.kind}`}>
      <p className="text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee]" style={DISPLAY}>
        {failure.title}
      </p>
      {failure.detail && (
        <p className="mt-3 max-w-[65ch] text-[13px] leading-[1.7] text-[#b8b5a8]" style={MONO}>
          {failure.detail}
        </p>
      )}
    </div>
  );
}

function ActivityBlock({ summary, href }: { summary: ActivitySummary; href: string }) {
  return (
    <div>
      {summary.measured ? (
        <dl
          className="grid grid-cols-1 gap-x-10 gap-y-3 text-[13px] sm:grid-cols-[auto_1fr]"
          style={MONO}
        >
          <dt className="text-[#8a8779]">Last 24 hours</dt>
          <dd className="text-[#f5f4ee] tabular-nums">{summary.last24h} calls</dd>
          <dt className="text-[#8a8779]">Total</dt>
          <dd className="text-[#f5f4ee] tabular-nums">
            {summary.total} calls <span className="text-[#8a8779]">{summary.since}</span>
          </dd>
          {summary.lastActivity && (
            <>
              <dt className="text-[#8a8779]">Last call</dt>
              <dd className="text-[#f5f4ee] tabular-nums">{summary.lastActivity}</dd>
            </>
          )}
        </dl>
      ) : (
        <p
          className="max-w-[65ch] text-[13px] leading-[1.7] text-[#b8b5a8]"
          style={MONO}
          data-testid="overview-activity-unmeasured"
        >
          {summary.message}
        </p>
      )}
      <Link href={href} className={`mt-4 inline-block ${TEXT_LINK}`} style={MONO}>
        Open activity
      </Link>
    </div>
  );
}

/**
 * Overview tab (#449, design §2.2). Every fact here is read from the deployed
 * WASM or the index; there is no prose written by Signet and no placeholder
 * for a missing description. The three §1.5 spec failures each render their
 * own copy, and the build, activity and run sections render in all of them.
 */
export default async function ContractOverviewPage({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  const attribution = await attributeContract(handle, address);
  // The layout has already 404'd or rendered its own unavailable state.
  if (attribution.status !== 'attributed') return null;

  const { contract } = attribution;
  const [specInput, snapshot] = await Promise.all([
    loadOverviewSpec({
      address,
      network: normalizeNetwork(contract.network),
      wasmHash: contract.wasmHash,
    }),
    loadLatestSnapshot(address, contract.network),
  ]);

  const overview = summariseSpec(specInput);
  const activity = summariseActivity(snapshot);
  const href = (segment: string) => contractTabSegmentHref(handle, address, segment);

  return (
    <section className="space-y-14">
      <div>
        <SectionLabel as="h2">Overview</SectionLabel>
        <div className="mt-6">
          {overview.status === 'ok' ? (
            <InterfaceBlock
              summary={overview.interface}
              hrefs={{ functions: href('functions'), types: href('types') }}
            />
          ) : (
            <FailureBlock failure={overview.failure} />
          )}
        </div>
      </div>

      {overview.status === 'ok' && overview.build && (
        <div>
          <SectionLabel>Build</SectionLabel>
          <p className="mt-4 text-[13px] leading-[1.7] text-[#b8b5a8]" style={MONO}>
            {overview.build}
          </p>
        </div>
      )}

      <div>
        <SectionLabel>Activity</SectionLabel>
        <div className="mt-4">
          <ActivityBlock summary={activity} href={href('activity')} />
        </div>
      </div>

      <div>
        <SectionLabel>Run it locally</SectionLabel>
        <p className="mt-4 max-w-[65ch] text-[13px] leading-[1.7] text-[#b8b5a8]" style={MONO}>
          Fork this contract&apos;s deployed code and storage into a local environment with the{' '}
          <code className="text-[#f5f4ee]">signet dev</code> command.
        </p>
        <Link href={href('run')} className={`mt-4 inline-block ${TEXT_LINK}`} style={MONO}>
          Open run locally
        </Link>
      </div>
    </section>
  );
}
