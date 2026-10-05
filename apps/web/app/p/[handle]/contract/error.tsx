'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { buildContractError, renderContractError } from '@/lib/contract-error';
import { STELLAR_NETWORK_NAME } from '@/lib/network';

// Lives in `contract/`, for the same reason as `not-found.tsx`: the layout is
// where attribution is decided, and it throws when neither the indexer nor
// Horizon can be reached. An error boundary beside that layout would not catch
// it. This is for that case and for unexpected throws below the layout only.
// A spec that was reached but cannot be read (no interface, a Stellar Asset
// Contract, the RPC down) is content, not an error: it renders inline on the
// tab under a 200 (`DocsState`, #470), and never reaches this boundary.
// The view lives in `lib/contract-error.ts` so it can be unit-tested.

export default function ContractError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  /** Re-fetches and re-renders the segment: what a server-side failure needs. */
  retry: () => void;
}) {
  const params = useParams<{ handle?: string }>();

  useEffect(() => {
    // The message of a server error is redacted on the client; the digest is
    // what matches this to the server log.
    console.error('[signet] contract route error', error.digest);
  }, [error]);

  return renderContractError(
    buildContractError({
      handle: params?.handle,
      digest: error.digest,
      networkName: STELLAR_NETWORK_NAME,
    }),
    retry,
  );
}
