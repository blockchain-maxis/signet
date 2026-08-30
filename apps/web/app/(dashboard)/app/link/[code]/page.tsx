import { getPairingForApproval } from '@/lib/server/cli-pairing';
import { AutoRefresh, ApprovePanel } from './approve-panel';

const mono = { fontFamily: 'var(--font-mono)' } as const;
const display = { fontFamily: 'var(--font-display)' } as const;

function truncate(a: string): string {
  return a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

const STATUS_COPY: Record<string, string> = {
  'waiting-for-cli':
    'Waiting for the CLI to prove control of this deploy key. This page updates automatically.',
  expired: 'This pairing request has expired. Run `signet link` again to start a new one.',
  consumed: 'This pairing has already completed. You can close this tab.',
  approved:
    'Already approved. If your terminal is still waiting, it should pick this up shortly — or use the completion code it showed at the time.',
};

export default async function CliLinkApprovalPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const pairing = await getPairingForApproval(code);

  return (
    <section>
      <h1 className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]" style={display}>
        Link CLI
      </h1>

      {!pairing ? (
        <p className="mt-6 max-w-[640px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
          Pairing session not found. Run <code>signet link</code> again to start a new one.
        </p>
      ) : (
        <>
          <p className="mt-6 max-w-[640px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
            A terminal is requesting to link the following deploy wallet to your handle.
          </p>

          <div className="mt-8 max-w-[640px] border border-[#1f1d19] px-6 py-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#b8b5a8]" style={mono} title={pairing.publicKey}>
                {truncate(pairing.publicKey)}
              </span>
              <span className="text-[9px] uppercase tracking-[0.18em] text-[#5e5b51]" style={mono}>
                {pairing.network}
              </span>
            </div>
          </div>

          {pairing.status === 'pending' ? (
            <ApprovePanel pairingCode={code} />
          ) : (
            <p className="mt-8 max-w-[640px] text-[13px] leading-[1.7] text-[#8a8779]" style={mono}>
              {STATUS_COPY[pairing.status]}
            </p>
          )}

          {pairing.status === 'waiting-for-cli' && <AutoRefresh />}
        </>
      )}
    </section>
  );
}
