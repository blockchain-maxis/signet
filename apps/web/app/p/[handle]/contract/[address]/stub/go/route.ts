import { NextRequest } from 'next/server';
import { handleContractStubGo } from '@/lib/server/contract-stub';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ handle: string; address: string }> },
) {
  const { handle, address } = await context.params;
  return handleContractStubGo(req, { handle, address });
}

export async function HEAD(
  req: NextRequest,
  context: { params: Promise<{ handle: string; address: string }> },
) {
  const { handle, address } = await context.params;
  return handleContractStubGo(req, { handle, address });
}
