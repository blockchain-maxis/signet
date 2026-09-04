/**
 * Pairing audit vocabulary — the events emitted when a wallet becomes bound to
 * a handle, or stops being bound.
 *
 * Linking is the operation most worth an audit trail: it is how an account
 * becomes attributed to a person, so a disputed or hijacked binding has to be
 * investigable after the fact. Both tiers emit these through their own logger,
 * so the names and the field shape live here rather than being spelled out
 * twice and drifting.
 *
 * **No key material, ever.** A binding is proved by a signature; the audit
 * trail records only what is already public — the handle, the wallet's public
 * address, and the outcome. {@link pairingEvent} refuses anything that looks
 * like a secret rather than trusting each call site to remember.
 */

/** Stage of a pairing, from the observer's point of view. */
export type PairingOutcome = 'started' | 'completed' | 'rejected' | 'unlinked';

/** Log message name per outcome. Stable strings — log queries match on them. */
export const PAIRING_EVENTS = {
  started: 'pairing.linkStarted',
  completed: 'pairing.linkCompleted',
  rejected: 'pairing.linkRejected',
  unlinked: 'pairing.unlinked',
} as const satisfies Record<PairingOutcome, string>;

export type PairingEventName = (typeof PAIRING_EVENTS)[PairingOutcome];

export interface PairingEventInput {
  /** The handle being bound or released. Omitted when an event could not be decoded far enough to name one. */
  handle?: string | null;
  /** The wallet's **public** address (`G…`/`C…`). */
  wallet?: string | null;
  /** Why, for `rejected` and `unlinked` — e.g. `undecodable-event`, `released`, `revoked`. */
  reason?: string | null;
  /** Ledger the observation came from, when the source is the event stream. */
  ledger?: number | null;
  /** The source that observed it, e.g. `attestation-worker`, `reconcile`. */
  source?: string | null;
}

export interface PairingEvent {
  /** Log message, one of {@link PAIRING_EVENTS}. */
  name: PairingEventName;
  /** Structured fields to log alongside it. */
  fields: Record<string, unknown>;
}

/** A Stellar secret seed. Never belongs in a log line. */
const SECRET_SEED = /\bS[A-Z2-7]{55}\b/;

/** Field names that carry, or hint at, key material. */
const FORBIDDEN_FIELD = /secret|seed|signature|privkey|private_?key|passphrase|token|cookie/i;

/** Thrown when a caller tries to put key material into the audit trail. */
export class PairingSecretLeakError extends Error {
  constructor(what: string) {
    super(
      `Refusing to log a pairing event: ${what}. The audit trail records the handle, the ` +
        `public wallet address and the outcome — never key material.`,
    );
    this.name = 'PairingSecretLeakError';
  }
}

/**
 * Builds one pairing audit event.
 *
 * @throws {PairingSecretLeakError} when a field is named like a secret or any
 *   value contains something shaped like a Stellar secret seed. Failing loudly
 *   beats emitting a line that then has to be scrubbed from every log sink it
 *   reached.
 */
export function pairingEvent(outcome: PairingOutcome, input: PairingEventInput = {}): PairingEvent {
  const fields: Record<string, unknown> = { outcome };

  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_FIELD.test(key))
      throw new PairingSecretLeakError(`field "${key}" is not loggable`);
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && SECRET_SEED.test(value)) {
      throw new PairingSecretLeakError(`field "${key}" contains what looks like a secret seed`);
    }
    fields[key] = value;
  }

  return { name: PAIRING_EVENTS[outcome], fields };
}
