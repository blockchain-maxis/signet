import { currentAddress } from '@/lib/server/session';
import { getAccount } from '@/lib/server/account';
import { redirect } from 'next/navigation';
import { Button } from '@/components/button';
import { createCliLinkToken } from '@/lib/cli-auth';

const display = { fontFamily: 'var(--font-display)' } as const;
const mono = { fontFamily: 'var(--font-mono)' } as const;

export default async function ApproveCliPage(props: { searchParams: Promise<{ pubkey?: string; callback?: string }> }) {
  const searchParams = await props.searchParams;
  const address = await currentAddress();
  if (!address) {
    redirect('/');
  }

  const account = await getAccount(address);
  const { pubkey, callback } = searchParams;

  if (!pubkey || !callback) {
    return (
      <section>
        <h1 className="text-[32px] font-bold text-[#8b1a1a]" style={display}>Error</h1>
        <p className="mt-4" style={mono}>Missing pubkey or callback in URL parameters.</p>
      </section>
    );
  }

  if (!account.handle) {
    return (
      <section>
        <h1 className="text-[32px] font-bold text-[#8b1a1a]" style={display}>Profile Not Found</h1>
        <p className="mt-4" style={mono}>You need to claim a handle on-chain before you can link a deploy key.</p>
      </section>
    );
  }

  const approveLink = async () => {
    'use server';
    const profileId = account.id; // wait, account.id doesn't exist? account might just have handle. 
    // Let's look up the profile ID. Wait, I'll fix this below.
    // The account object in getAccount has the profile id? I will look at getAccount.
  };

  return (
    <section>
      <h1 className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]" style={display}>
        Link Deploy Key
      </h1>
      
      <p className="mt-6 max-w-[640px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
        The Signet CLI wants to link a deploy key to your profile. Once linked, contracts deployed with this key will be attributed to your handle (@{account.handle}).
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

        <form action={async () => {
          'use server';
          const { prisma } = await import('@signet/db');
          const userWallet = await prisma.wallet.findUnique({
            where: { pubkey: address },
            select: { profileId: true }
          });
          if (!userWallet) throw new Error('Profile not found');
          
          const token = createCliLinkToken(pubkey, userWallet.profileId);
          const callbackUrl = new URL(callback);
          callbackUrl.searchParams.set('token', token);
          callbackUrl.searchParams.set('handle', account.handle || '');
          redirect(callbackUrl.toString());
        }}>
          <Button type="submit" className="w-full justify-center">Approve Link</Button>
        </form>
      </div>
    </section>
  );
}
