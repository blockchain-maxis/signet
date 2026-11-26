import { exportDiagramFragment } from '@/lib/server/diagram-fragment';

export const dynamic = 'force-dynamic';

/** The Embed diagram's drawn region for one `?expand=` state (#949). */
export async function GET(
  request: Request,
  context: { params: Promise<{ handle: string; address: string }> },
) {
  return exportDiagramFragment(request, await context.params);
}
