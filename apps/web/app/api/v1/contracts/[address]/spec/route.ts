import { contractSpecApi } from '../../../../../../lib/api/v1/contract-spec.ts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ address: string }> };

export async function GET(req: Request, context: Context) {
  return contractSpecApi.byAddress(req, (await context.params).address);
}

export const OPTIONS = GET;
