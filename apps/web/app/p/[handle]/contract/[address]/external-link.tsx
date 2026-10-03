/**
 * Link that opens in a new tab and says so (#461): the hidden text is what a
 * screen reader appends to the link name, since `target="_blank"` changes
 * where the user ends up without telling them.
 */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
