import Link from 'next/link';
import { SectionLabel } from '../../../_components/section-label';

/** Placeholder segment for the Diagram tab (#445); its epic fills it in. */
export default function DiagramPage() {
  return (
    <section>
      <SectionLabel as="h2">Diagram</SectionLabel>
      <p
        className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Not built yet — this tab exists so the URL is stable and linkable.
      </p>
      <p className="mt-4 text-[13px] leading-[1.7] text-[#8a8779]">
        <Link
          href="/docs#reading-a-contract-diagram"
          className="underline decoration-[#8a8779] underline-offset-2 transition-colors hover:text-[#f5f4ee]"
        >
          How the diagram will be read →
        </Link>
      </p>
    </section>
  );
}
