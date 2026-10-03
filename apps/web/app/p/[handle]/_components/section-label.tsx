/**
 * Shared section heading for the profile page and the contract sub-route
 * (#445): both surfaces must stay visually identical, so exactly one file
 * owns this markup. Moved verbatim from `app/p/[handle]/page.tsx`.
 */
export function SectionLabel({
  children,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  /** Element to render. The contract tabs pass `h2` (#461): it is each tab's heading. */
  as?: 'div' | 'h2';
}) {
  return (
    <Tag
      className="flex items-center gap-3 text-[10px] uppercase tracking-[0.26em] text-[#8a8779]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" aria-hidden="true" />
      {children}
    </Tag>
  );
}
