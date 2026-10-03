/**
 * The wire contract between the Go CLI and the CLI routes — the single source
 * of truth for their request and response bodies and for every failure `code`
 * an error body can carry.
 *
 * The routes under `apps/web/app/api/cli/**` and `apps/web/app/api/cli-link`
 * type their bodies against these, and `scripts/generate-cli-spec-go.mjs`
 * renders them to `cli/internal/spec/zz_generated_api.go` so the CLI decodes
 * the same shapes. `scripts/check-cli-spec-go.mjs` fails CI when the Go file
 * drifts — change this file, then run `node scripts/generate-cli-spec-go.mjs`.
 *
 * The generator deliberately understands only a small subset of TypeScript,
 * and fails loudly on anything else rather than guessing:
 *   - `export type X = 'a' | 'b' | Y;` — string literals, or other such unions;
 *   - `export interface X { field: T; field?: T; }` — T is `string`,
 *     `boolean`, `number`, `string | null`, or a union declared here.
 * Comments are allowed anywhere. Nothing else is.
 *
 * Error bodies are `{ error, code }`. `error` is written for the person at the
 * terminal and is free to change; `code` is what the CLI branches on, so it
 * must not change meaning — add a new value instead.
 */

// ── failure codes ─────────────────────────────────────────────────────────

/** Refusals any CLI route can give before it looks at the request's subject. */
export type RequestFailure = 'bad-request' | 'rate-limited' | 'cross-origin' | 'not-signed-in';

/** `POST /api/cli/pair/start`. */
export type StartFailure =
  | 'invalid-public-key'
  | 'unknown-network'
  | 'network-mismatch'
  | 'unavailable';

/** `GET /api/cli/pair/status` — an unknown and a wrong token are both `not-found`. */
export type PollFailure = 'unavailable' | 'not-found';

/** `POST /api/cli/pair/approve`. */
export type ApproveFailure =
  | 'not-found'
  | 'expired'
  | 'already-used'
  | 'no-profile'
  | 'no-key'
  | 'unavailable';

export type ApproveOutcome = 'ok' | ApproveFailure;

/** `POST /api/cli/pair/reject`. */
export type RejectFailure = 'not-found' | 'expired' | 'already-used' | 'unavailable';

export type RejectOutcome = 'ok' | RejectFailure;

/** `POST /api/cli/pair/complete`. */
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

/** `POST /api/cli/unlink`. */
export type UnlinkFailure =
  | 'unavailable'
  | 'bad-challenge'
  | 'replayed'
  | 'not-linked'
  | 'primary-wallet';

/** `GET` / `POST /api/cli-link`. `unavailable` is a missing signing key here. */
export type CliLinkFailure = 'network-mismatch' | 'bad-challenge' | 'unavailable';

/**
 * Every value an error body's `code` can hold. A code means the same thing on
 * every route that uses it, which is what lets the CLI map codes to exit codes
 * in one table (`cli/internal/spec/errors.go`).
 */
export type CliFailureCode =
  | RequestFailure
  | StartFailure
  | PollFailure
  | ApproveFailure
  | RejectFailure
  | CompleteFailure
  | UnlinkFailure
  | CliLinkFailure;

/** What a pairing's progress reads as, from `GET /api/cli/pair/status`. */
export type PollStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'expired';

// ── bodies ────────────────────────────────────────────────────────────────

/** Every non-2xx response from a CLI route. */
export interface ErrorBody {
  error: string;
  code: CliFailureCode;
}

export interface PairStartRequest {
  /** A network name (`testnet`, `mainnet`), never a passphrase (#616). */
  network: string;
  publicKey?: string;
}

export interface PairStartResponse {
  state: string;
  pollToken: string;
  userCode: string;
  expiresAt: string;
}

export interface PairStatusResponse {
  status: PollStatus;
}

export interface PairApproveRequest {
  state: string;
}

export interface PairApproveResponse {
  ok: boolean;
  handoffCode: string;
}

export interface PairRejectRequest {
  state: string;
}

export interface PairRejectResponse {
  ok: boolean;
}

export interface PairCompleteRequest {
  state: string;
  transaction: string;
  handoffCode?: string;
}

export interface PairCompleteResponse {
  ok: boolean;
  wallet: string;
  handle: string | null;
  indexingPending: boolean;
}

export interface UnlinkRequest {
  transaction: string;
}

export interface UnlinkResponse {
  ok: boolean;
  wallet: string;
  handle: string | null;
}

export interface WhoamiResponse {
  publicKey: string;
  handle: string | null;
  linked: boolean;
  /** A network name, like `PairStartRequest.network`. */
  network: string;
}

/** `GET /api/cli-link` and `GET /api/auth/sep10`. */
export interface ChallengeResponse {
  transaction: string;
  network_passphrase: string;
}

export interface CliLinkVerifyRequest {
  transaction: string;
}

export interface CliLinkVerifyResponse {
  verified: boolean;
  publicKey: string;
}
