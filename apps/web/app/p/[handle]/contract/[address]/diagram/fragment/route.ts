import { exportDiagramFragment } from '@/lib/server/diagram-fragment';

export const dynamic = 'force-dynamic';

/** The Diagram tab's drawn region for one `?expand=` state (#502). */
export async function GET(
  request: Request,
  context: { params: Promise<{ handle: string; address: string }> },
) {
  return exportDiagramFragment(request, await context.params);
}
