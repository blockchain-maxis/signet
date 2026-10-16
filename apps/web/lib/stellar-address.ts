/**
 * Cheap shape guards for Stellar public keys (G… StrKey, base32, 56 chars)
 * and contract IDs (C… StrKey, base32, 56 chars).
 *
 * Not a checksum validation: downstream libraries (such as Keypair or StrKey)
 * do the cryptographic check and throw on bad keys.
 */
export const G_ADDRESS = /^G[A-Z2-7]{55}$/;
export const C_ADDRESS = /^C[A-Z2-7]{55}$/;
export const STELLAR_ADDR_RE = /^[GC][A-Z2-7]{55}$/;

export function isValidStellarAddress(address: string, kind?: 'G' | 'C'): boolean {
  if (kind === 'G') return G_ADDRESS.test(address);
  if (kind === 'C') return C_ADDRESS.test(address);
  return G_ADDRESS.test(address);
}

export function isValidAddressOrContract(address: string): boolean {
  return STELLAR_ADDR_RE.test(address);
}
