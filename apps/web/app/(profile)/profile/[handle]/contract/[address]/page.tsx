import { permanentRedirect } from 'next/navigation';
import { isContractAddress } from '@/lib/contract-address';

/**
 * Legacy per-contract route. A well-formed contract address redirects to the
 * dedicated contract view at /p/{handle}/contract/{address}; anything else
 * falls back to the profile, so a malformed old link still lands somewhere
 * useful.
 *
 * No attribution check here: the destination runs it and 404s if the handle
 * does not own the contract.
 */
export default async function LegacyContractRedirect({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  const profile = `/p/${handle.toLowerCase()}`;
  permanentRedirect(isContractAddress(address) ? `${profile}/contract/${address}` : profile);
}
