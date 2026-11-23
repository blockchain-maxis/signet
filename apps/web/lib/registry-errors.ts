import { contractErrorMessage, parseClaimError } from './contract-errors.ts';

/**
 * Identity Registry claim errors raised during simulation (`Error(Contract, #N)`)
 * or transaction submission, mapped to plain user-facing messages.
 *
 * Unknown contract codes and unrelated errors preserve the original error text so
 * callers still see actionable details instead of losing context.
 */
const CLAIM_CONTRACT_CODES = new Set([3, 6, 7, 8]);
const RELEASE_CONTRACT_CODES = new Set([4, 5]);

const CONTRACT_ERROR_CODE_RE = /Error\(Contract,\s*#(\d+)\)/i;
const AUTH_ERROR_RE = /Error\(Auth,\s*InvalidAction\)|Error\(Auth|authentication failed/i;

/**
 * Extract the plain error message for a claim error (simulation or submission).
 * Explains contract codes 3 (`HandleTaken`), 6 (`InvalidHandle`), 7 (`WalletAlreadyBound`),
 * and 8 (`HandleReserved`). Unrecognised errors keep their original message.
 */
export function explainRegistryError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Claim failed';

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

/**
 * Extract the plain error message for a release error (simulation or submission).
 * Explains contract codes 4 (`HandleNotFound`), 5 (`NotOwner`), and Soroban auth
 * failures when the connected wallet is not the owner.
 * Unrecognised errors keep their original message.
 */
export function explainReleaseError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Release failed';

  const simMatch = raw.match(CONTRACT_ERROR_CODE_RE);
  if (simMatch?.[1]) {
    const code = Number(simMatch[1]);
    if (RELEASE_CONTRACT_CODES.has(code)) {
      return contractErrorMessage(code);
    }
    return raw;
  }

  if (AUTH_ERROR_RE.test(raw)) {
    return contractErrorMessage(5);
  }

  if (error instanceof Error) {
    const parsed = parseClaimError(error);
    if (parsed !== error.message) {
      return parsed;
    }
  }

  return raw;
}
