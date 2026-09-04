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
 * replayed, but a challenge the developer signed intending to link can still
 * be redeemed to unlink by whoever holds it. Binding the challenge to the
 * operation it was minted for is #269, tracked in #343, and needs the
 * challenge itself to carry the purpose — it cannot be retrofitted here.
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
