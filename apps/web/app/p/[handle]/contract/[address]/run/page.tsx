import { RunPageClient } from './run-client';

interface RunPageProps {
  params: Promise<{ handle: string; address: string }>;
}

// Server component. It used to live in the same `'use client'` file as
// `RunPageClient`, which made this async function a client component: the
// page rendered on the server but never hydrated, so the copy button did
// nothing. Splitting the client half out (#461) is what makes it work.
export default async function RunPage({ params }: RunPageProps) {
  const { handle, address } = await params;
  const { attributeContract } = await import('@/lib/contract-attribution');
  const attribution = await attributeContract(handle, address);

  if (attribution.status !== 'attributed') {
    return null;
  }

  const network = attribution.contract.network;

  return <RunPageClient address={address} network={network} />;
}