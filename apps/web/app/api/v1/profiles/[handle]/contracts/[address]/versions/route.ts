import { contractVersionsHandler } from '../../../../../../../../lib/api/v1/contract-versions.ts';

export const runtime = 'nodejs';

const handle = contractVersionsHandler();

export const GET = handle;
export const OPTIONS = handle;
