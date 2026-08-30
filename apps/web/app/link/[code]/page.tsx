import { getLinkState, isValidPairingCode } from '@/lib/link-pairing';
import { LINK_PAIR_TTL_MS } from '@signet/types';
import { ApproveButton } from './approve-button';

export const dynamic = 'force-dynamic';

/**
 * The browser side of `signet link`. A developer who runs the command opens
 * this page (via the printed URL), approves, and the CLI's poll loop observes
 * the flip. A code that is unknown or expired renders a terminal state instead
 * of an approve button — matching the CLI, which stops waiting on the same TTL.
 */
export default async function LinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const state = isValidPairingCode(code) ? getLinkState(code) : 'expired';

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0908] px-6 text-[#f5f4ee]">
      <div className="w-full max-w-md border border-[#1f1d19] px-8 py-10">
        <div
          className="text-[10px] uppercase tracking-[0.26em] text-[#5e5b51]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Signet · Terminal link
        </div>

        {state === 'pending' ? (
          <>
            <h1 className="mt-5 text-[22px] font-bold leading-tight tracking-[-0.02em]">
              Approve this device?
            </h1>
            <p className="mt-3 text-[14px] leading-[1.6] text-[#8a8779]">
              A <code className="text-[#f5f4ee]">signet link</code> command is waiting for this
              approval. It will wait up to {LINK_PAIR_TTL_MS / 60_000} minutes, then give up with
              instructions to retry.
            </p>
            <div
              className="mt-6 border border-[#1f1d19] bg-[#12100d] px-4 py-3 text-[18px] font-medium tracking-[0.3em] text-[#f5f4ee]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {code}
            </div>
            <div className="mt-6">
              <ApproveButton code={code} />
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-5 text-[22px] font-bold leading-tight tracking-[-0.02em]">
              {state === 'approved' ? 'Already approved' : 'This link has expired'}
            </h1>
            <p className="mt-3 text-[14px] leading-[1.6] text-[#8a8779]">
              {state === 'approved' ? (
                <>This pairing was approved and can no longer be approved again.</>
              ) : (
                <>
                  The pairing code expired before it was approved. Run{' '}
                  <code className="text-[#f5f4ee]">signet link</code> again to get a fresh code.
                </>
              )}
            </p>
          </>
        )}
      </div>
    </main>
  );
}