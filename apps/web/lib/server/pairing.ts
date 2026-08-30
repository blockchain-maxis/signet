import { createHash } from 'node:crypto';
import { consumeNonce } from '../nonce-store.ts';
import { verifyChallenge, getNetworkPassphrase, Sep10Error } from '../sep10.ts';
import { logger } from '../logger.ts';

/**
 * CLI device pairing — the trust boundary that turns a browser-approved
 * pairing into a `Wallet` row, without either side ever seeing the other's
 * credentials.
 *
 * Three steps, three distinct proofs:
 *
 *   1. `start`    — the CLI mints a `PairingState` row (unauthenticated: the
 *                   CLI has no session and no signed challenge yet, it is
 *                   just asking for something to show the user).
 *   2. `approve`  — the **browser**, authenticated via its Sign-In With
 *                   Stellar session, records which `Profile` is pairing.
 *                   This is proof #1: "I own this handle."
 *   3. `complete` — the **CLI**, authenticated via a signed SEP-10 challenge
 *                   for the deploy account, writes the `Wallet` row. This is
 *                   proof #2: "I control this deploy account." Neither proof
 *                   alone is enough — accepting either side's bare assertion
 *                   is exactly how an attacker would claim someone else's
 *                   already-deployed contracts.
 *
 * `status` only ever moves forward — pending → approved → completed — and
 * every transition that matters is a conditional update (`WHERE status =
 * '<expected>'`), so two concurrent calls racing the same pairing cannot both
 * win. The signed challenge itself is additionally spent via `consumeNonce`
 * (see `completePairing`), so the same signature cannot complete two
 * pairings, or the same pairing twice.
 */

const PAIRING_TTL_MS = 5 * 60 * 1000;
/** How long a spent challenge's nonce is remembered — must outlive the SEP-10 challenge's own timebounds. */
const CHALLENGE_REPLAY_TTL_MS = 10 * 60 * 1000;

interface PairingRow {
  id: string;
  status: string;
  network: string;
  profileId: string | null;
  expiresAt: Date;
}

interface WalletRow {
  pubkey: string;
  profileId: string;
}

/**
 * Minimal slice of the Prisma client this module touches, as an interface —
 * same pattern as the indexer's `AttestationStore` / `SeedStore` — so tests
 * can inject an in-memory fake instead of a real database, including for the
 * conditional-update races that are the whole point of this module.
 */
export interface PairingStore {
  pairingState: {
    create(args: { data: { network: string; expiresAt: Date } }): Promise<{ id: string }>;
    findUnique(args: { where: { id: string } }): Promise<PairingRow | null>;
    updateMany(args: {
      where: { id: string; status: string; expiresAt?: { gt: Date } };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  wallet: {
    findUnique(args: { where: { pubkey: string } }): Promise<WalletRow | null>;
    create(args: {
      data: { pubkey: string; profileId: string; source: string; isPrimary: boolean };
    }): Promise<WalletRow>;
  };
  $transaction<T>(fn: (tx: PairingStore) => Promise<T>): Promise<T>;
}

/** `null` when no database is configured — every caller degrades to "pairing unavailable". */
async function getStore(): Promise<PairingStore | null> {
  if (!process.env.DATABASE_URL) return null;
  const { prisma } = await import('@signet/db');
  return prisma as unknown as PairingStore;
}

// ── start ────────────────────────────────────────────────────────────────

export interface StartedPairing {
  state: string;
  expiresAt: string;
}

/** Mint a pairing for `network` (a Stellar network passphrase). */
export async function startPairing(
  network: string,
  store?: PairingStore,
): Promise<StartedPairing | null> {
  const db = store ?? (await getStore());
  if (!db) return null;

  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  const row = await db.pairingState.create({ data: { network, expiresAt } });
  return { state: row.id, expiresAt: expiresAt.toISOString() };
}

// ── approve ──────────────────────────────────────────────────────────────

export type ApproveOutcome =
  | 'ok'
  | 'not-found'
  | 'expired'
  | 'already-used'
  | 'no-profile'
  | 'unavailable';

/**
 * Record that the signed-in `address`'s profile is approving `state`.
 *
 * `no-profile` (the address has no bound `Wallet`, so no profile to pair)
 * fails closed rather than pairing against nothing — a pairing that
 * `complete` could later write a wallet for without any profile owning it.
 */
export async function approvePairing(
  state: string,
  address: string,
  store?: PairingStore,
): Promise<ApproveOutcome> {
  const db = store ?? (await getStore());
  if (!db) return 'unavailable';

  const wallet = await db.wallet.findUnique({ where: { pubkey: address } });
  if (!wallet) {
    logger.warn({ state, address }, 'pairing.approveNoProfile');
    return 'no-profile';
  }

  const now = new Date();
  const result = await db.pairingState.updateMany({
    where: { id: state, status: 'pending', expiresAt: { gt: now } },
    data: { status: 'approved', profileId: wallet.profileId, approvedAt: now },
  });
  if (result.count === 1) {
    logger.info({ state, profileId: wallet.profileId }, 'pairing.approved');
    return 'ok';
  }

  // The conditional updateMany above is what actually prevents a race (two
  // concurrent approvals, or an approval racing an expiry); this second read
  // only distinguishes the outcome for logging/the caller.
  const existing = await db.pairingState.findUnique({ where: { id: state } });
  const outcome: ApproveOutcome = !existing ? 'not-found' : existing.expiresAt <= now ? 'expired' : 'already-used';
  logger.warn({ state, outcome }, 'pairing.approveRejected');
  return outcome;
}

// ── complete ─────────────────────────────────────────────────────────────

export type CompleteFailure =
  | 'unavailable'
  | 'not-found'
  | 'expired'
  | 'not-approved'
  | 'already-completed'
  | 'network-mismatch'
  | 'bad-challenge'
  | 'replayed'
  | 'wallet-bound-elsewhere';

export type CompleteResult =
  | { ok: true; wallet: WalletRow }
  | { ok: false; reason: CompleteFailure };

/** Thrown inside the transaction to short-circuit to a specific `CompleteFailure`. */
class PairingConflict extends Error {
  readonly reason: CompleteFailure;
  constructor(reason: CompleteFailure) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Verify the CLI's signed SEP-10 challenge for an approved pairing and write
 * the `Wallet` row.
 *
 * Ordering is deliberate, same rationale as `auth.ts`'s `redeemChallenge`:
 * the pairing/network checks and signature verification happen first (they
 * are free — no state is spent by a failed attempt), and the nonce is
 * consumed only once a *valid* signature is in hand, immediately before the
 * write. Consuming it any earlier would let a bystander who only sees the
 * challenge (it is not secret) burn it with a junk signature and lock out the
 * real caller; consuming it any later would let two concurrent completions
 * of the same signed challenge both pass verification before either spent it.
 */
export async function completePairing(
  state: string,
  challengeXdr: string,
  store?: PairingStore,
): Promise<CompleteResult> {
  const db = store ?? (await getStore());
  if (!db) return { ok: false, reason: 'unavailable' };

  const pairing = await db.pairingState.findUnique({ where: { id: state } });
  if (!pairing) return fail(state, 'not-found');
  if (pairing.status === 'completed') return fail(state, 'already-completed');
  if (pairing.status !== 'approved' || !pairing.profileId) return fail(state, 'not-approved');
  if (pairing.expiresAt <= new Date()) return fail(state, 'expired');
  if (pairing.network !== getNetworkPassphrase()) return fail(state, 'network-mismatch');

  let clientAccountId: string;
  try {
    clientAccountId = verifyChallenge(challengeXdr);
  } catch (err) {
    logger.warn(
      { state, error: err instanceof Sep10Error ? err.message : String(err) },
      'pairing.badChallenge',
    );
    return { ok: false, reason: 'bad-challenge' };
  }

  // One nonce per distinct signed challenge — a byte-identical resubmission
  // (the only kind an attacker who intercepted the signed XDR could produce)
  // hashes the same and is rejected; a *fresh* challenge for a *completed*
  // pairing is caught separately, by the transaction below.
  const nonce = createHash('sha256').update(challengeXdr).digest('hex');
  if (!(await consumeNonce(`pair:${nonce}`, CHALLENGE_REPLAY_TTL_MS))) {
    return fail(state, 'replayed');
  }

  const profileId = pairing.profileId;
  try {
    const wallet = await db.$transaction(async (tx) => {
      // Conditioned on still being 'approved': a second completion attempt
      // (replayed request, or a distinct signed challenge for the same
      // pairing) sees 0 rows updated and aborts here, before touching Wallet.
      const flipped = await tx.pairingState.updateMany({
        where: { id: state, status: 'approved' },
        data: { status: 'completed', completedAt: new Date() },
      });
      if (flipped.count !== 1) throw new PairingConflict('already-completed');

      const existing = await tx.wallet.findUnique({ where: { pubkey: clientAccountId } });
      if (existing) {
        if (existing.profileId !== profileId) throw new PairingConflict('wallet-bound-elsewhere');
        return existing; // already bound to this profile — idempotent re-pairing
      }
      return tx.wallet.create({
        data: { pubkey: clientAccountId, profileId, source: 'cli', isPrimary: false },
      });
    });
    logger.info({ state, profileId, pubkey: clientAccountId }, 'pairing.completed');
    return { ok: true, wallet };
  } catch (err) {
    if (err instanceof PairingConflict) return fail(state, err.reason);
    throw err;
  }
}

function fail(state: string, reason: CompleteFailure): CompleteResult {
  logger.warn({ state, reason }, 'pairing.completeRejected');
  return { ok: false, reason };
}
