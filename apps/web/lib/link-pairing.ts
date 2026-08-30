/**
 * Backend state for terminal linking (`signet link`).
 *
 * The CLI asks the server for a pairing code, prints it with an approval URL,
 * then polls until the code is approved or expires. This module holds the
 * browser-approved side of that handshake: creating a code, approving it, and
 * reporting its state — all against a single shared TTL so a code can never be
 * approved after the CLI has already given up waiting on it.
 *
 * The store is in-memory and per-process, which is exactly right for a
 * dev/terminal-linking convenience (each `signet link` is a short,
 * human-paced transaction). It is deliberately not a pluggable Redis store the
 * way `nonce-store.ts` is, because approving a link on a *different* server
 * instance than the one that created it is not a failure mode worth
 * engineering for here — and a shared store would add key-management
 * complexity for no safety gain.
 *
 * The map lives on `globalThis` rather than at module scope because Next.js
 * dev bundles each route handler separately: a module-level map would exist
 * once per route bundle, and the create route's pair would be invisible to the
 * status route. `globalThis` is shared by every bundle in the process, and the
 * production single-bundle server shares it too.
 */

import { randomInt } from 'node:crypto';
import { LINK_PAIR_TTL_MS, LINK_POLL_INTERVAL_MS } from '@signet/types';

/** What the CLI can observe a pairing settle into. */
export type LinkState = 'pending' | 'approved' | 'rejected' | 'expired';

/** The browser can only move a pair from `pending` to `approved`. */
type LinkPairStatus = 'pending' | 'approved';

/**
 * Unambiguous pairing-code alphabet: no I/L/O/U/0/O/1, so a code displayed on
 * one screen can be typed without guessing.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 8;

/** A supplied pairing code, after validation — 8 chars from the alphabet. */
export const PAIRING_CODE_RE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/;

export function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_RE.test(code);
}

function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

interface LinkPair {
  code: string;
  status: LinkPairStatus;
  createdAt: number;
  expiresAt: number;
}

/** Sweep-expired pairs bound the map without a background timer. */
const MAX_PAIRS = 512;

// `Symbol.for` so every (re)compiled copy of this module in the process — and
// every Next.js dev route bundle — resolves the same key on `globalThis`.
const STORE_KEY = Symbol.for('signet.link-pairing.pairs');

type PairStore = Map<string, LinkPair>;

function pairs(): PairStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (!(STORE_KEY in g) || !(g[STORE_KEY] instanceof Map)) {
    g[STORE_KEY] = new Map<string, LinkPair>();
  }
  return g[STORE_KEY] as PairStore;
}

function sweepExpired(now: number): void {
  const store = pairs();
  if (store.size < MAX_PAIRS) return;
  for (const [code, pair] of store) {
    if (now >= pair.expiresAt) store.delete(code);
  }
}

/** Result of attempting to approve a pairing code. */
export type ApproveResult = 'ok' | 'expired' | 'not-found';

function pairState(pair: LinkPair, now: number): LinkState {
  if (now >= pair.expiresAt) return 'expired';
  return pair.status;
}

/** Create a pending pairing code; returns the fields the CLI prints. */
export function createLinkPair(ttlMs: number = LINK_PAIR_TTL_MS): {
  pairingCode: string;
  ttlMs: number;
  intervalMs: number;
} {
  const now = Date.now();
  sweepExpired(now);
  const code = generateCode();
  pairs().set(code, { code, status: 'pending', createdAt: now, expiresAt: now + ttlMs });
  return { pairingCode: code, ttlMs, intervalMs: LINK_POLL_INTERVAL_MS };
}

/** Mark a pairing code approved in the browser. */
export function approveLinkPair(code: string): ApproveResult {
  const trimmed = code.trim();
  if (!isValidPairingCode(trimmed)) return 'not-found';
  const pair = pairs().get(trimmed);
  if (!pair) return 'not-found';
  if (Date.now() >= pair.expiresAt) return 'expired';
  pair.status = 'approved';
  return 'ok';
}

/** Report a pairing's state to the CLI, treating unknown codes as expired. */
export function getLinkState(code: string): LinkState {
  const trimmed = code.trim();
  if (!isValidPairingCode(trimmed)) return 'expired';
  const pair = pairs().get(trimmed);
  if (!pair) return 'expired';
  return pairState(pair, Date.now());
}

/** Test-only: clear all pairings for a clean slate. */
export function __resetLinkPairs(): void {
  pairs().clear();
}