import { createHash } from 'node:crypto';
import { consumeNonce } from '../nonce-store.ts';

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
 * Hashed rather than stored whole: the envelope is long, and the nonce store
 * only needs to recognise it again.
 */
export async function spendChallenge(challengeXdr: string): Promise<boolean> {
  const hash = createHash('sha256').update(challengeXdr).digest('hex');
  return consumeNonce(`sep10-challenge:${hash}`, CHALLENGE_REPLAY_TTL_MS);
}
