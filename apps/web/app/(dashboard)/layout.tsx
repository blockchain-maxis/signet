import Link from 'next/link';
import { cookies } from 'next/headers';
import { SignetMonogram } from '../(marketing)/components/signet-monogram';
import { verifySession, SESSION_COOKIE } from '@/lib/auth';
import { SignInGate } from './components/sign-in-gate';

/**
 * Dashboard shell (app.signet.dev). Gated by Sign-In With Stellar: the layout
 * reads the session cookie and only renders the dashboard to an authenticated
 * wallet; otherwise it shows the sign-in wall.
 */
const NAV = [
  { href: '/app', label: 'Overview' },
  { href: '/app/profile', label: 'Profile' },
  { href: '/app/wallets', label: 'Wallets' },
  { href: '/app/settings', label: 'Settings' },
];

function truncate(a: string): string {
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const address = await verifySession(token);

  return (
    <div className="min-h-screen bg-[#0a0908] text-[#f5f4ee]">
      <nav className="flex items-center justify-between border-b border-[#1f1d19] px-8 py-6 md:px-14">
        <Link href="/" className="flex items-center gap-3">
          <SignetMonogram className="h-5 w-5 text-[#f5f4ee]" />
          <span className="text-[14px] font-medium tracking-tight">Signet</span>
        </Link>
        {address && (
          <div
            className="hidden gap-7 text-[11px] uppercase tracking-[0.22em] text-[#8a8779] md:flex"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="transition-colors hover:text-[#f5f4ee]">
                {item.label}
              </Link>
            ))}
          </div>
        )}
        <span
          className="text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {address ? `● ${truncate(address)}` : 'Not signed in'}
        </span>
      </nav>
      <main className="mx-auto max-w-5xl px-8 py-16 md:px-14">
        {address ? children : <SignInGate />}
      </main>
    </div>
  );
}

/** Honest panel used by each in-progress dashboard surface. */
export function DashboardPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h1
        className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {title}
      </h1>
      <div
        className="mt-8 max-w-[640px] border border-[#1f1d19] px-6 py-6 text-[14px] leading-[1.7] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {children}
      </div>
    </section>
  );
}
