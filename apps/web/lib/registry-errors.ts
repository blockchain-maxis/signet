import { contractErrorMessage, parseClaimError } from './contract-errors.ts';

/**
 * Identity Registry claim errors raised during simulation (`Error(Contract, #N)`)
 * or transaction submission, mapped to plain user-facing messages.
 *
 * Unknown contract codes and unrelated errors preserve the original error text so
 * callers still see actionable details instead of losing context.
 */
const CLAIM_CONTRACT_CODES = new Set([3, 6, 7, 8]);

const CONTRACT_ERROR_CODE_RE = /Error\(Contract,\s*#(\d+)\)/i;

/**
 * Extract the plain error message for a registry error (simulation or submission).
 * Explains contract codes 3 (`HandleTaken`), 6 (`InvalidHandle`), 7 (`WalletAlreadyBound`),
 * and 8 (`HandleReserved`). Unrecognised errors keep their original message.
 */
export function explainRegistryError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Claim failed';

  const simMatch = raw.match(CONTRACT_ERROR_CODE_RE);
  if (simMatch?.[1]) {
    const code = Number(simMatch[1]);
    if (CLAIM_CONTRACT_CODES.has(code)) {
      return contractErrorMessage(code);
    }
    return raw;
  }

  if (error instanceof Error) {
    const parsed = parseClaimError(error);
    if (parsed !== error.message) {
      return parsed;
    }
  }

  return raw;
}
