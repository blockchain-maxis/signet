/**
 * @file The fork's accounts (#581), for the address picker: every account
 * entry the session's fork holds, decoded from its ledger key.
 */

import { StrKey, xdr } from '@stellar/stellar-sdk';

/** G… addresses of the account entries among the fork's keys, sorted, without duplicates. */
export function forkAccounts(entries: readonly { key: string }[]): string[] {
  const out = new Set<string>();
  for (const { key } of entries) {
    try {
      const k = xdr.LedgerKey.fromXDR(key, 'base64');
      if (k.switch().name !== 'account') continue;
      out.add(StrKey.encodeEd25519PublicKey(k.account().accountId().ed25519()));
    } catch {
      // not a ledger key this picker can use
    }
  }
  return [...out].sort();
}
