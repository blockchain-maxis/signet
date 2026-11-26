import { TransactionBuilder } from '@stellar/stellar-sdk';
import { consumeNonce } from '../nonce-store.ts';
import { getNetworkPassphrase } from '../sep10.ts';

/**
 * Single-use accounting for signed SEP-10 challenges, shared by every
 * operation that accepts one.
 *
 * The namespace is deliberately shared rather than per-operation. A signed
 * challenge is a bearer proof of key control and nothing in its contents says
 * what it is *for*, so if pairing spent `pair:<hash>` and unlink spent
 * `unlink:<hash>` the same intercepted envelope could be redeemed once against
 * each. One namespace means one use, full stop, whichever operation reaches it
 * first.
 *
 * This is single-use, not operation binding: it stops a challenge being
 * replayed, not redeemed for the wrong operation. That is the challenge's own
 * job — it carries its purpose in its home domain (`cli-link.ts`, #622), so a
 * challenge signed intending to link is refused by unlink before it is spent.
 */

/** Must outlive the SEP-10 challenge's own timebounds. */
export const CHALLENGE_REPLAY_TTL_MS = 10 * 60 * 1000;

/**
 * Spend `challengeXdr`. Returns false if it has already been spent.
 *
 * The spend key is the transaction hash (not the envelope bytes) so that
 * re-encoding the same signed transaction cannot produce a new key.
 */
export async function spendChallenge(challengeXdr: string): Promise<boolean> {
  const tx = TransactionBuilder.fromXDR(challengeXdr, getNetworkPassphrase());
  const hash = tx.hash().toString('hex');
  return consumeNonce(`sep10-challenge:${hash}`, CHALLENGE_REPLAY_TTL_MS);
}
