import Link from 'next/link';
import { SignetMonogram } from '../../../../(marketing)/components/signet-monogram';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/** The docs pages' frame: the docs page's own nav, and a main column. */
export function DocsShell({
  children,
  crumb,
}: {
  children: React.ReactNode;
  /** Where "back" goes, shown left of the nav's right side. */
  crumb?: { href: string; label: string };
}) {
  return (
    <div className="min-h-screen bg-[#0a0908] text-[#f5f4ee]">
      <nav
        aria-label="Docs"
        className="flex items-center justify-between gap-6 border-b border-[#1f1d19] px-4 py-6 sm:px-8 md:px-14"
      >
        <Link href="/" className="flex items-center gap-3">
          <SignetMonogram className="h-5 w-5 text-[#f5f4ee]" />
          <span className="text-[14px] font-medium tracking-tight">Signet</span>
        </Link>
        <div
          className="flex items-center gap-6 text-[11px] uppercase tracking-[0.22em] text-[#8a8779]"
          style={mono}
        >
          {crumb && (
            <Link href={crumb.href} className="transition-colors hover:text-[#f5f4ee]">
              {crumb.label}
            </Link>
          )}
          <Link href="/docs" className="transition-colors hover:text-[#f5f4ee]">
            Docs
          </Link>
        </div>
      </nav>
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-8 md:px-14">{children}</main>
    </div>
  );
}

export function SectionHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-14 text-[11px] uppercase tracking-[0.26em] text-[var(--text-accent)]"
      style={mono}
    >
      {children}
    </h2>
  );
}

export function SubHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="mt-8 text-[13px] font-medium text-[#f5f4ee]" style={mono}>
      {children}
    </h3>
  );
}

export const prose = 'mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]';

/** HTTP method + path, as a monospace line. */
export function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <p className="mt-4 text-[13px] text-[#f5f4ee]" style={mono}>
      <span className="mr-3 text-[var(--text-accent)]">{method}</span>
      /api/v1{path}
    </p>
  );
}
