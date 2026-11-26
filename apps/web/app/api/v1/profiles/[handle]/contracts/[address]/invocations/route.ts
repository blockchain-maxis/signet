import { contractInvocationsHandler } from '../../../../../../../../lib/api/v1/contract-invocations.ts';

export const runtime = 'nodejs';

const handle = contractInvocationsHandler();

export const GET = handle;
export const OPTIONS = handle;
