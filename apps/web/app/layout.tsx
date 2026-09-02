import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const title = 'Signet';
const description = 'A verifiable developer career record built on Stellar/Soroban.';

// Self-hosted at build time by next/font — no runtime request to Google Fonts,
// so page text no longer waits on a third-party stylesheet + font fetch.
const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title,
  description,
  openGraph: {
    title,
    description,
    siteName: title,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
  },
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
    <html lang="en" className={`${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
