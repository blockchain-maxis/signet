import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

/**
 * Alphabet for the handoff code: Crockford base32 minus the characters that
 * get misread off a screen and retyped wrong (I, L, O, U). The code is read
 * by a human and typed by a human, which is the only reason it is short
 * enough to be worth restricting.
 */
const HANDOFF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HANDOFF_LENGTH = 8;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Constant-time compare of two hex digests. */
function hashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

interface PairingRow {
  id: string;
  status: string;
  network: string;
  publicKey: string | null;
  handoffHash: string | null;
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
    create(args: {
      data: {
        network: string;
        publicKey?: string | null;
        pollTokenHash?: string | null;
        expiresAt: Date;
      };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { id: string } | { pollTokenHash: string };
    }): Promise<PairingRow | null>;
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
  /**
   * Bearer credential for `GET /api/cli/pair/status`, returned exactly once
   * and never stored in the clear. Deliberately not `state`: the pairing code
   * goes into the URL the developer opens, and a link that has been pasted
   * into a chat should not also hand over the ability to watch the pairing.
   */
  pollToken: string;
  expiresAt: string;
}

/**
 * Mint a pairing for `network` (a Stellar network passphrase).
 *
 * `publicKey` is the deploy account the CLI says it is about to link. It is
 * recorded unverified — the CLI has proved nothing at this point — purely so
 * `/link` can show the developer which key they are approving. What makes
 * showing it meaningful is `completePairing`, which refuses to attach any key
 * other than this one, so the page cannot display one account while a
 * different one gets bound.
 */
export async function startPairing(
  network: string,
  publicKey?: string | null,
  store?: PairingStore,
): Promise<StartedPairing | null> {
  const db = store ?? (await getStore());
  if (!db) return null;

  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  const pollToken = randomBytes(32).toString('base64url');
  const row = await db.pairingState.create({
    data: {
      network,
      publicKey: publicKey ?? null,
      pollTokenHash: sha256(pollToken),
      expiresAt,
    },
  });
  return { state: row.id, pollToken, expiresAt: expiresAt.toISOString() };
}

// ── poll (the fallback for terminals the browser cannot reach) ────────────

/**
 * What `GET /api/cli/pair/status` reports. `expired` is derived rather than
 * stored — a pairing nobody touched again is still `pending` in the table
 * long after it stopped being usable, and the CLI needs to stop waiting.
 */
export type PollStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'expired';

export type PollResult =
  | { ok: true; status: PollStatus }
  | { ok: false; reason: 'unavailable' | 'not-found' };

/**
 * Report a pairing's progress to the CLI holding its poll token.
 *
 * The whole point of #273: loopback is unreachable from a remote SSH session,
 * an unmapped container port, or a locked-down browser, and for those
 * developers the local callback can never arrive. Polling gives them the same
 * flow with the same trust boundary — this only *reads* progress. Approval
 * still requires the browser session and attachment still requires the signed
 * challenge, so nothing here is a second way to get a wallet linked.
 */
export async function pollPairing(pollToken: string, store?: PairingStore): Promise<PollResult> {
  const db = store ?? (await getStore());
  if (!db) return { ok: false, reason: 'unavailable' };

  const row = await db.pairingState.findUnique({
    where: { pollTokenHash: sha256(pollToken) },
  });
  if (!row) return { ok: false, reason: 'not-found' };

  if (row.status === 'pending' && row.expiresAt <= new Date()) {
    return { ok: true, status: 'expired' };
  }
  return { ok: true, status: row.status as PollStatus };
}

// ── describe (the browser approval page) ─────────────────────────────────

export type PairingView =
  | { ok: true; state: string; publicKey: string | null; expiresAt: string }
  | { ok: false; reason: 'unavailable' | 'not-found' | 'expired' | 'already-used' };

/**
 * Read a pairing for `/link` to render.
 *
 * Deliberately returns nothing but the declared key and the expiry: the page
 * shows the developer what they are approving, and a pairing they cannot
 * approve is refused outright rather than rendered in a dead state. It never
 * discloses `profileId`, so a leaked code cannot be turned into a lookup of
 * who has been pairing.
 */
export async function describePairing(state: string, store?: PairingStore): Promise<PairingView> {
  const db = store ?? (await getStore());
  if (!db) return { ok: false, reason: 'unavailable' };

  const row = await db.pairingState.findUnique({ where: { id: state } });
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status !== 'pending') return { ok: false, reason: 'already-used' };
  if (row.expiresAt <= new Date()) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    state: row.id,
    publicKey: row.publicKey,
    expiresAt: row.expiresAt.toISOString(),
  };
}

// ── approve ──────────────────────────────────────────────────────────────

export type ApproveResult =
  | { outcome: 'ok'; handoffCode: string }
  | { outcome: Exclude<ApproveOutcome, 'ok'> };

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
): Promise<ApproveResult> {
  const db = store ?? (await getStore());
  if (!db) return { outcome: 'unavailable' };

  const wallet = await db.wallet.findUnique({ where: { pubkey: address } });
  if (!wallet) {
    logger.warn({ state, address }, 'pairing.approveNoProfile');
    return { outcome: 'no-profile' };
  }

  // Minted here rather than at `start` so it cannot exist before somebody has
  // actually approved: a code the browser has not yet shown is a code that
  // proves nothing.
  const handoffCode = randomHandoffCode();

  const now = new Date();
  const result = await db.pairingState.updateMany({
    where: { id: state, status: 'pending', expiresAt: { gt: now } },
    data: {
      status: 'approved',
      profileId: wallet.profileId,
      approvedAt: now,
      handoffHash: sha256(handoffCode),
    },
  });
  if (result.count === 1) {
    logger.info({ state, profileId: wallet.profileId }, 'pairing.approved');
    return { outcome: 'ok', handoffCode };
  }

  // The conditional updateMany above is what actually prevents a race (two
  // concurrent approvals, or an approval racing an expiry); this second read
  // only distinguishes the outcome for logging/the caller.
  const existing = await db.pairingState.findUnique({ where: { id: state } });
  const outcome: ApproveOutcome = !existing
    ? 'not-found'
    : existing.expiresAt <= now
      ? 'expired'
      : 'already-used';
  logger.warn({ state, outcome }, 'pairing.approveRejected');
  return { outcome };
}

/** Short, human-transcribable code the browser shows after approving. */
function randomHandoffCode(): string {
  const bytes = randomBytes(HANDOFF_LENGTH);
  let code = '';
  for (const b of bytes) code += HANDOFF_ALPHABET[b % HANDOFF_ALPHABET.length];
  return code;
}

// ── reject ───────────────────────────────────────────────────────────────

export type RejectOutcome = 'ok' | 'not-found' | 'expired' | 'already-used' | 'unavailable';

/**
 * Record that the developer refused `state` in the browser.
 *
 * A refusal is a terminal state of its own rather than a silent no-op, so the
 * CLI can say "rejected" and exit immediately instead of polling until the
 * TTL runs out — the difference between a flow that answers and one that
 * appears to hang, which is the same complaint #265 makes about the wait.
 *
 * Unlike `approve` this does not need a profile: nothing is being bound, and
 * requiring one would leave a developer who has not claimed a handle unable
 * to refuse a pairing they did not start.
 */
export async function rejectPairing(state: string, store?: PairingStore): Promise<RejectOutcome> {
  const db = store ?? (await getStore());
  if (!db) return 'unavailable';

  const now = new Date();
  const result = await db.pairingState.updateMany({
    where: { id: state, status: 'pending', expiresAt: { gt: now } },
    data: { status: 'rejected', rejectedAt: now },
  });
  if (result.count === 1) {
    logger.info({ state }, 'pairing.rejected');
    return 'ok';
  }

  const existing = await db.pairingState.findUnique({ where: { id: state } });
  const outcome: RejectOutcome = !existing
    ? 'not-found'
    : existing.expiresAt <= now
      ? 'expired'
      : 'already-used';
  logger.warn({ state, outcome }, 'pairing.rejectRejected');
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
  | 'key-mismatch'
  | 'bad-handoff'
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
  handoffCode?: string,
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

  // The manual path (#273): when the loopback callback cannot be reached, the
  // developer pastes the code the browser showed after approving. Checked only
  // when the CLI supplies one — the loopback and polling paths prove the same
  // thing by other means, and requiring it there would make every link a typing
  // exercise. When it *is* supplied it must be right: a wrong code is a signal
  // that the person at the terminal is not the person who approved.
  if (handoffCode !== undefined) {
    if (!pairing.handoffHash || !hashEquals(pairing.handoffHash, sha256(handoffCode))) {
      return fail(state, 'bad-handoff');
    }
  }

  // The browser was shown `pairing.publicKey` and approved *that* key. Binding
  // anything else now would make the approval page a lie — the developer would
  // have consented to one account while another was attached. Pairings minted
  // before the column existed carry null and skip the check; they were never
  // rendered with a key to disagree with.
  if (pairing.publicKey && pairing.publicKey !== clientAccountId) {
    logger.warn(
      { state, declared: pairing.publicKey, signed: clientAccountId },
      'pairing.keyMismatch',
    );
    return fail(state, 'key-mismatch');
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
