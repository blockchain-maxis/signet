/**
 * The grant portal's one question: did this applicant's Signet handle deploy
 * the contract they say they built?
 *
 * Everything the page needs comes from here, and every SDK error becomes a
 * result the page can show, so an applicant is never told "not verified" when
 * the truth is "Signet could not check right now".
 */
import {
  NetworkError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
  type ProfileResponse,
  type SignetClient,
  type V1Data,
  type V1Schemas,
} from '@signet/sdk';

/** The slice of the SDK this portal uses, so tests can pass a fake. */
export type Signet = Pick<
  SignetClient,
  'verifyDeployment' | 'getProfile' | 'getWallets' | 'listContracts'
>;

export type Wallet = V1Data<'getHandleWallets'>[number];
export type Contract = V1Schemas['ProfileContract'];

interface Found {
  profile: ProfileResponse;
  wallets: Wallet[];
  contracts: Contract[];
  /** True when the contract list is partial (capped, or no layer could list it). */
  contractsTruncated: boolean;
}

export type Verification =
  | ({ kind: 'verified'; attribution: { method: string; wallet: string } } & Found)
  | ({ kind: 'not-attributed' } & Found)
  | { kind: 'no-profile' }
  | { kind: 'invalid'; parameter: string | null; message: string }
  | { kind: 'rate-limited'; retryAfterSeconds: number | null }
  | { kind: 'unavailable'; message: string }
  | { kind: 'network'; message: string };

/** How many of the applicant's contracts the page lists. */
export const CONTRACTS_SHOWN = 20;

export async function verifyApplicant(
  signet: Signet,
  handle: string,
  address: string,
): Promise<Verification> {
  try {
    const profile = await signet.getProfile(handle);
    if (!profile) return { kind: 'no-profile' };
    const [verdict, wallets, page] = await Promise.all([
      signet.verifyDeployment(handle, address),
      signet.getWallets(handle),
      signet.listContracts(handle, { limit: CONTRACTS_SHOWN }),
    ]);
    const found: Found = {
      profile,
      wallets: wallets ?? [],
      contracts: page.data,
      contractsTruncated: page.meta.truncated || page.meta.nextCursor !== null,
    };
    return verdict.verified && verdict.attribution
      ? { kind: 'verified', attribution: verdict.attribution, ...found }
      : { kind: 'not-attributed', ...found };
  } catch (err) {
    if (err instanceof ValidationError) {
      return { kind: 'invalid', parameter: err.parameter ?? null, message: err.message };
    }
    if (err instanceof RateLimitedError) {
      return { kind: 'rate-limited', retryAfterSeconds: err.retryAfterSeconds };
    }
    if (err instanceof UnavailableError) return { kind: 'unavailable', message: err.message };
    if (err instanceof NetworkError) return { kind: 'network', message: err.message };
    throw err;
  }
}
