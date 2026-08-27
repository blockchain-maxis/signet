/**
 * Maps numeric error codes from the Identity Registry Soroban contract to
 * human-readable messages.
 *
 * The contract's `Error` enum (packages/contracts/identity-registry/src/lib.rs)
 * is a `#[contracterror]` repr(u32) — Soroban surfaces the discriminant as a
 * numeric code in the XDR error result. This module gives each code a string
 * that can be shown directly in the UI.
 *
 * Unknown codes (e.g. from a future contract upgrade the frontend hasn't caught
 * up with) fall back to a generic message rather than crashing or showing raw
 * numbers.
 */

/**
 * Human-readable messages keyed by their contract Error discriminant.
 *
 * Codes 8 and 9 exist in the contract source but not in the currently deployed
 * wasm (see `docs/REGISTRY_INTEGRATION.md` §2), so they are unreachable against
 * today's testnet instance. They are mapped anyway: the alternative is that the
 * first deployment carrying them silently degrades a precise, actionable
 * message into the generic fallback.
 */
const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1: 'The registry is already initialised.', // AlreadyInitialized
  2: 'The registry has not been initialised yet.', // NotInitialized
  3: 'That handle is already taken.', // HandleTaken
  4: 'Handle not found.', // HandleNotFound
  5: 'You are not the owner of that handle.', // NotOwner
  6: 'That handle is invalid. Use 1–32 lowercase letters, digits, hyphens, or underscores.', // InvalidHandle
  7: 'This wallet already has a handle.', // WalletAlreadyBound
  8: 'That handle is reserved for a Signet route.', // HandleReserved
  9: 'Too many handles in one batch — resolve at most 100 at a time.', // BatchTooLarge
} as const;

const FALLBACK_MESSAGE = 'An unexpected contract error occurred. Please try again.';

/**
 * Return a human-readable message for the given contract error code.
 *
 * @param code - Numeric error discriminant from the Identity Registry contract.
 * @returns A user-facing string. Falls back to a generic message for unknown codes.
 *
 * @example
 * contractErrorMessage(3); // "That handle is already taken."
 * contractErrorMessage(99); // "An unexpected contract error occurred. Please try again."
 */
export function contractErrorMessage(code: number): string {
  return CONTRACT_ERROR_MESSAGES[code] ?? FALLBACK_MESSAGE;
}

/**
 * Parse a raw error thrown by `claimHandle` and return a human-readable
 * message. Soroban encodes contract errors as JSON with a numeric `value`
 * inside the `errorResult` field; this helper extracts it and maps it via
 * `contractErrorMessage`.
 *
 * Falls back to the original error message when the payload cannot be parsed
 * (e.g. network errors, non-contract errors).
 *
 * @param error - The error thrown by `claimHandle`.
 * @returns A user-facing string safe to display in the UI.
 */
export function parseClaimError(error: unknown): string {
  if (!(error instanceof Error)) {
    return FALLBACK_MESSAGE;
  }

  // claimHandle throws: `Claim submission failed: <JSON>`
  // The JSON may contain a nested `errorResult` with a Soroban contract error.
  const payload = error.message.match(/:\s*(\{.*\})\s*$/s)?.[1];
  if (payload) {
    try {
      // Walk the parsed object looking for a numeric contract error code.
      const code = extractContractErrorCode(JSON.parse(payload));
      if (code !== null) {
        return contractErrorMessage(code);
      }
    } catch {
      // JSON.parse failed — fall through to raw message.
    }
  }

  return error.message;
}

/**
 * Recursively search a parsed Soroban error result for the contract error code.
 *
 * Soroban's XDR error result serialises to something like:
 * `{ "code": "contractError", "value": 3 }`
 * but the exact shape can vary by SDK version, so we walk the object.
 */
function extractContractErrorCode(obj: unknown): number | null {
  if (typeof obj !== 'object' || obj === null) return null;

  const record = obj as Record<string, unknown>;

  // Direct numeric `value` field adjacent to `"contractError"` code.
  if (record['code'] === 'contractError' && typeof record['value'] === 'number') {
    return record['value'] as number;
  }

  // Recurse into child values.
  for (const val of Object.values(record)) {
    const found = extractContractErrorCode(val);
    if (found !== null) return found;
  }

  return null;
}
