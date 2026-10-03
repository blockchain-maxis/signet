import { SectionLabel } from '../../_components/section-label';

/** Overview (index) tab placeholder (#445); #449 builds the real overview. */
export default function ContractOverviewPage() {
  return (
    <section>
      <SectionLabel as="h2">Overview</SectionLabel>
      <p
        className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Not built yet — this tab exists so the URL is stable and linkable.
      </p>
    </section>
  );
}
