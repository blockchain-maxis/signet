import { randomBytes, timingSafeEqual } from 'node:crypto';
import { verifySignature } from '../auth.ts';
import { isValidStellarAddress } from '../stellar-address.ts';
import { linkDeployWallet, type LinkWalletStore } from './account.ts';

/**
 * `signet link`'s loopback fallback: a polling path and a manual-code path,
 * for the setups where a local loopback callback can never work — remote SSH
 * sessions, dev containers with unmapped ports, locked-down corporate
 * browsers (see https://github.com/blockchain-maxis/signet/issues/273).
 *
 * Protocol:
 *   1. `startPairing` — the CLI mints a session for its deploy `publicKey`,
 *      getting back a short `pairingCode` (for the browser URL) and a secret
 *      `pollToken` (for polling), plus a `nonce` it must sign.
 *   2. `submitPairingProof` — the CLI signs `nonce` with the deploy wallet's
 *      key and posts the signature, proving control of `publicKey` — the
 *      first of the two proofs required before a link can complete.
 *   3. The developer opens the pairing URL in a signed-in browser tab, which
 *      calls `approvePairing` — the second proof (that the signed-in session
 *      is authorized to modify its own profile) — and links the wallet.
 *   4. The CLI collects the result either by polling `pollPairing(pollToken)`
 *      until it flips to approved, or — when even outbound polling isn't an
 *      option, or simply as the more direct path — by the developer copying
 *      the `completionCode` the browser shows after approving and pasting it
 *      into the terminal, via `completePairingManually`.
 *
 * Both collection paths share one atomic "consume" step (`consumeApproved`),
 * so completion is single-use regardless of which path reaches it first.
 * Neither path weakens the trust boundary of the two proofs above — they only
 * change how the CLI *learns* that both proofs were satisfied.
 */

const PAIRING_TTL_MS = 5 * 60 * 1000;

// Crockford-ish alphabet, ambiguous characters (0/O, 1/I) removed — these
// codes are read off a screen and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(groups: number, groupLen: number): string {
  const bytes = randomBytes(groups * groupLen);
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    let part = '';
    for (let i = 0; i < groupLen; i++) {
      part += CODE_ALPHABET[bytes[g * groupLen + i]! % CODE_ALPHABET.length];
    }
    parts.push(part);
  }
  return parts.join('-');
}

export class CliPairingError extends Error {
  readonly code:
    | 'invalid-public-key'
    | 'no-database'
    | 'not-found'
    | 'expired'
    | 'bad-signature'
    | 'unproven'
    | 'invalid-state'
    | 'no-profile';

  constructor(code: CliPairingError['code'], message: string) {
    super(message);
    this.name = 'CliPairingError';
    this.code = code;
  }
}

export interface CliPairingRecord {
  id: string;
  pairingCode: string;
  pollToken: string;
  nonce: string;
  completionCode: string | null;
  publicKey: string;
  network: string;
  proven: boolean;
  status: string;
  profileId: string | null;
  expiresAt: Date;
}

/**
 * The persistence surface this module needs — mirrors `LinkWalletStore` /
 * `DeploymentStore`'s injectable-store pattern, so the proof/approve/consume
 * logic can be tested without a database.
 */
export interface CliPairingStore {
  create(args: {
    data: {
      pairingCode: string;
      pollToken: string;
      nonce: string;
      publicKey: string;
      network: string;
      status: string;
      proven: boolean;
      expiresAt: Date;
    };
  }): Promise<CliPairingRecord>;
  findFirst(args: {
    where: { pairingCode?: string; pollToken?: string };
  }): Promise<CliPairingRecord | null>;
  update(args: {
    where: { id: string };
    data: Partial<Pick<CliPairingRecord, 'proven' | 'status' | 'profileId' | 'completionCode'>>;
  }): Promise<CliPairingRecord>;
  /** Conditional update — the `where.status` guard is what makes consumption atomic/single-use. */
  updateMany(args: {
    where: { id: string; status: string };
    data: Partial<Pick<CliPairingRecord, 'status' | 'profileId' | 'completionCode'>>;
  }): Promise<{ count: number }>;
}

async function getStore(): Promise<CliPairingStore> {
  if (!process.env.DATABASE_URL) {
    throw new CliPairingError('no-database', 'CLI pairing requires a configured database');
  }
  const { prisma } = await import('@signet/db');
  return prisma.cliPairing as unknown as CliPairingStore;
}

/** The message the CLI must sign with `publicKey` to prove control of the deploy key. */
export function pairingProofMessage(pairingCode: string, nonce: string): string {
  return `Signet CLI pairing\nCode: ${pairingCode}\nNonce: ${nonce}`;
}

export interface PairingStart {
  pairingCode: string;
  pollToken: string;
  nonce: string;
  expiresAt: string;
}

/** Mint a pairing session for `publicKey`. `network` is trusted as-is (checked by the caller route). */
export async function startPairing(
  publicKey: string,
  network: string,
  store?: CliPairingStore,
): Promise<PairingStart> {
  if (!isValidStellarAddress(publicKey)) {
    throw new CliPairingError('invalid-public-key', 'publicKey must be a valid Stellar G… address');
  }
  const db = store ?? (await getStore());
  const row = await db.create({
    data: {
      pairingCode: randomCode(2, 4),
      pollToken: randomBytes(24).toString('base64url'),
      nonce: randomBytes(16).toString('base64url'),
      publicKey,
      network,
      status: 'pending',
      proven: false,
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    },
  });
  return {
    pairingCode: row.pairingCode,
    pollToken: row.pollToken,
    nonce: row.nonce,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function isExpired(row: CliPairingRecord): boolean {
  return row.expiresAt.getTime() < Date.now();
}

/** Verify the CLI's signature over `nonce` and mark the session's key-ownership proof satisfied. */
export async function submitPairingProof(
  pollToken: string,
  signatureB64: string,
  store?: CliPairingStore,
): Promise<void> {
  const db = store ?? (await getStore());
  const row = await db.findFirst({ where: { pollToken } });
  if (!row) throw new CliPairingError('not-found', 'Pairing session not found');
  if (isExpired(row)) throw new CliPairingError('expired', 'This pairing request has expired');
  if (row.status !== 'pending') {
    throw new CliPairingError('invalid-state', 'This pairing request has already been handled');
  }

  const message = pairingProofMessage(row.pairingCode, row.nonce);
  const ok = await verifySignature(row.publicKey, message, signatureB64);
  if (!ok) throw new CliPairingError('bad-signature', 'Signature does not match the deploy key');

  await db.update({ where: { id: row.id }, data: { proven: true } });
}

export interface PairingApprovalView {
  publicKey: string;
  network: string;
  expiresAt: string;
  /** 'waiting-for-cli' until the signature proof lands; the approve action is only valid once 'pending'. */
  status: 'waiting-for-cli' | 'pending' | 'approved' | 'consumed' | 'expired';
}

/** Public, read-only view of a session for the browser approval page — never exposes `pollToken`/`nonce`. */
export async function getPairingForApproval(
  pairingCode: string,
  store?: CliPairingStore,
): Promise<PairingApprovalView | null> {
  const db = store ?? (await getStore());
  const row = await db.findFirst({ where: { pairingCode } });
  if (!row) return null;
  const expired = isExpired(row);
  return {
    publicKey: row.publicKey,
    network: row.network,
    expiresAt: row.expiresAt.toISOString(),
    status: expired
      ? 'expired'
      : row.status !== 'pending'
        ? (row.status as 'approved' | 'consumed')
        : row.proven
          ? 'pending'
          : 'waiting-for-cli',
  };
}

export interface ApproveResult {
  completionCode: string;
}

/** The narrow read this module needs to resolve a signed-in address to its profile. */
export interface ProfileLookupStore {
  wallet: {
    findUnique(args: {
      where: { pubkey: string };
      select: { profileId: true };
    }): Promise<{ profileId: string } | null>;
  };
}

async function getProfileLookupStore(): Promise<ProfileLookupStore> {
  if (!process.env.DATABASE_URL) {
    throw new CliPairingError('no-profile', 'CLI pairing requires a configured database');
  }
  const { prisma } = await import('@signet/db');
  return prisma as unknown as ProfileLookupStore;
}

/**
 * Approve a pairing as `address` (the signed-in wallet) and link the CLI's
 * deploy key to `address`'s profile. Requires the signature proof
 * (`submitPairingProof`) to have already landed — this is the second of the
 * two proofs the loopback path itself would also require: an authenticated
 * session, acting on its own profile.
 */
export async function approvePairing(
  pairingCode: string,
  address: string,
  store?: CliPairingStore,
  walletStore?: LinkWalletStore,
  profileLookup?: ProfileLookupStore,
): Promise<ApproveResult> {
  const db = store ?? (await getStore());
  const row = await db.findFirst({ where: { pairingCode } });
  if (!row) throw new CliPairingError('not-found', 'Pairing session not found');
  if (isExpired(row)) throw new CliPairingError('expired', 'This pairing request has expired');
  if (!row.proven) {
    throw new CliPairingError('unproven', 'Waiting for the CLI to prove control of the deploy key');
  }
  if (row.status !== 'pending') {
    throw new CliPairingError('invalid-state', 'This pairing request has already been handled');
  }

  const profiles = profileLookup ?? (await getProfileLookupStore());
  const self = await profiles.wallet.findUnique({
    where: { pubkey: address },
    select: { profileId: true },
  });
  if (!self) {
    throw new CliPairingError(
      'no-profile',
      'Sign in with a wallet that already has a claimed handle first',
    );
  }

  await linkDeployWallet(self.profileId, row.publicKey, 'cli', walletStore);

  const completionCode = randomCode(2, 4);
  const updated = await db.updateMany({
    where: { id: row.id, status: 'pending' },
    data: { status: 'approved', profileId: self.profileId, completionCode },
  });
  if (updated.count !== 1) {
    throw new CliPairingError('invalid-state', 'This pairing request has already been handled');
  }
  return { completionCode };
}

export interface PairingResult {
  publicKey: string;
  network: string;
  profileId: string;
}

export type PollOutcome =
  | { state: 'pending' }
  | { state: 'expired' }
  | { state: 'not-found' }
  | { state: 'approved'; result: PairingResult };

/** Atomically transition an approved row to consumed, returning the result exactly once. */
async function consumeApproved(
  row: CliPairingRecord,
  db: CliPairingStore,
): Promise<PairingResult | null> {
  const updated = await db.updateMany({
    where: { id: row.id, status: 'approved' },
    data: { status: 'consumed' },
  });
  if (updated.count !== 1) return null;
  return { publicKey: row.publicKey, network: row.network, profileId: row.profileId! };
}

/** The CLI's automatic path: poll until the browser has approved. */
export async function pollPairing(pollToken: string, store?: CliPairingStore): Promise<PollOutcome> {
  const db = store ?? (await getStore());
  const row = await db.findFirst({ where: { pollToken } });
  if (!row) return { state: 'not-found' };
  if (isExpired(row)) return { state: 'expired' };
  if (row.status === 'pending') return { state: 'pending' };
  if (row.status !== 'approved') return { state: 'not-found' }; // already consumed

  const result = await consumeApproved(row, db);
  return result ? { state: 'approved', result } : { state: 'not-found' };
}

/** The manual fallback: the developer pastes the code the browser showed after approving. */
export async function completePairingManually(
  pairingCode: string,
  completionCode: string,
  store?: CliPairingStore,
): Promise<PollOutcome> {
  const db = store ?? (await getStore());
  const row = await db.findFirst({ where: { pairingCode } });
  if (!row) return { state: 'not-found' };
  if (isExpired(row)) return { state: 'expired' };
  if (!row.completionCode || !constantTimeEqual(row.completionCode, completionCode)) {
    return { state: 'not-found' };
  }
  if (row.status === 'pending') return { state: 'pending' };
  if (row.status !== 'approved') return { state: 'not-found' }; // already consumed

  const result = await consumeApproved(row, db);
  return result ? { state: 'approved', result } : { state: 'not-found' };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
