import { badgeHandler } from '../../../../../lib/api/v1/badge.ts';

export const runtime = 'nodejs';

/**
 * GET /api/v1/badge/{handle}.svg (#656)
 *
 * A "Verified by Signet" badge: always a 200 SVG, its state in
 * X-Signet-Badge-State.
 */
const handle = badgeHandler();

export const GET = handle;
export const HEAD = handle;
