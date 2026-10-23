import { contractSpecApi } from '../../../../../lib/api/v1/contract-spec.ts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ wasmHash: string }> };

export async function GET(req: Request, context: Context) {
  return contractSpecApi.byHash(req, (await context.params).wasmHash);
}

export const OPTIONS = GET;
