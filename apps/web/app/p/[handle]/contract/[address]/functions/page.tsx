import { SectionLabel } from '../../../_components/section-label';

/** Placeholder segment for the Functions tab (#445); its epic fills it in. */
export default function FunctionsPage() {
  return (
    <section>
      <SectionLabel as="h2">Functions</SectionLabel>
      <p
        className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Not built yet — this tab exists so the URL is stable and linkable.
      </p>
    </section>
  );
}
