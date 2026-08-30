import { currentAddress } from '@/lib/server/session';
import { getAccount } from '@/lib/server/account';
import { redirect } from 'next/navigation';
import { verifyCliPairingCode, createCliLinkToken } from '@/lib/cli-auth';
import { DashboardPanel } from '../layout';

const display = { fontFamily: 'var(--font-display)' } as const;
const mono = { fontFamily: 'var(--font-mono)' } as const;

export default async function LinkPage(props: { searchParams: Promise<{ code?: string }> }) {
  const searchParams = await props.searchParams;
  const address = await currentAddress();
  if (!address) {
    redirect('/');
  }

  const account = await getAccount(address);
  const { code } = searchParams;

  if (!code) {
    return (
      <DashboardPanel title="Error">
        <p className="text-[#8b1a1a]">Missing pairing code.</p>
      </DashboardPanel>
    );
  }

  const verified = verifyCliPairingCode(code);
  if (!verified) {
    return (
      <DashboardPanel title="Error">
        <p className="text-[#8b1a1a]">The pairing code is expired or malformed.</p>
      </DashboardPanel>
    );
  }

  if (!account.handle) {
    return (
      <DashboardPanel title="Profile Not Found">
        <p className="text-[#8b1a1a]">You need to claim a handle on-chain before you can link a deploy key.</p>
      </DashboardPanel>
    );
  }

  const { pubkey, state } = verified;

  return (
    <section>
      <h1 className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]" style={display}>
        Link Deploy Key
      </h1>
      
      <p className="mt-6 max-w-[640px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
        Your local terminal wants to link a deploy key to your profile.
        Once linked, contracts deployed with this key will be attributed to your handle (@{account.handle}).
      </p>

      <div className="mt-8 max-w-[640px] border border-[#1f1d19] p-6">
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51]" style={mono}>Deploy Key</p>
          <p className="mt-1 text-[14px] text-[#b8b5a8] break-all" style={mono}>{pubkey}</p>
        </div>
        
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51]" style={mono}>Target Profile</p>
          <p className="mt-1 text-[14px] text-[#b8b5a8]" style={mono}>@{account.handle}</p>
        </div>

        <div className="flex gap-4">
          <form action={async () => {
            'use server';
            const { prisma } = await import('@signet/db');
            const userWallet = await prisma.wallet.findUnique({
              where: { pubkey: address },
              select: { profileId: true }
            });
            if (!userWallet) throw new Error('Profile not found');
            
            const token = createCliLinkToken(pubkey, userWallet.profileId);
            
            let callbackUrl: URL;
            try {
              callbackUrl = new URL(state);
            } catch {
              throw new Error('Invalid callback URL in state');
            }
            callbackUrl.searchParams.set('token', token);
            callbackUrl.searchParams.set('handle', account.handle || '');
            redirect(callbackUrl.toString());
          }}>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-3 bg-[#f5f4ee] px-7 py-4 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee]"
              style={mono}
            >
              Approve
            </button>
          </form>

          <form action={async () => {
            'use server';
            let callbackUrl: URL;
            try {
              callbackUrl = new URL(state);
            } catch {
              throw new Error('Invalid callback URL in state');
            }
            callbackUrl.searchParams.set('error', 'rejected');
            redirect(callbackUrl.toString());
          }}>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-3 border border-[#1f1d19] bg-transparent px-7 py-4 text-[12px] font-medium uppercase tracking-[0.18em] text-[#8a8779] transition-all duration-300 hover:bg-[#1f1d19] hover:text-[#f5f4ee]"
              style={mono}
            >
              Reject
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
