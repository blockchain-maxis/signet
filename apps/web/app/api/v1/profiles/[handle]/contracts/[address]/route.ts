import { profileContractHandler } from '../../../../../../../lib/api/v1/profile-contract.ts';

export const runtime = 'nodejs';

/**
 * GET /api/v1/profiles/{handle}/contracts/{address} (#632)
 *
 * The contract when one of the handle's wallets deployed it, else 404.
 */
const handle = profileContractHandler();

export const GET = handle;
export const OPTIONS = handle;
