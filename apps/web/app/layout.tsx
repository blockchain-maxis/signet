import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Signet',
  description: 'A verifiable developer career record built on Stellar/Soroban.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
