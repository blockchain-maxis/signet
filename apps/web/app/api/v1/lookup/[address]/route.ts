import { lookupHandler } from '../../../../../lib/api/v1/lookup.ts';

export const runtime = 'nodejs';

/**
 * GET /api/v1/lookup/{address} (#645)
 *
 * Which handle, if any, a G… wallet is attributed to on this deployment.
 */
const handle = lookupHandler();

export const GET = handle;
export const OPTIONS = handle;
