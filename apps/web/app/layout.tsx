import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: 'Signet',
  description: 'A verifiable developer career record built on Stellar/Soroban.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Touch a request header to opt every route into dynamic rendering, which a
  // nonce-based CSP requires: the per-request nonce set by `middleware.ts` isn't
  // known at build time, so statically prerendered HTML would ship inline
  // bootstrap scripts the policy can't match. Rendering per request lets Next
  // stamp the nonce onto those scripts automatically, so `script-src` needs no
  // `'unsafe-inline'`.
  await headers();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
