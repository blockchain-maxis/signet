import { exportContractDiagram } from '@/lib/server/diagram-export';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ handle: string; address: string }> },
) {
  return exportContractDiagram(request, await context.params);
}
