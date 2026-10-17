import { serveDiagramFragment } from '@/lib/server/diagram-fragment';

export const dynamic = 'force-dynamic';

/**
 * The server-rendered diagram fragment for one URL state (#502).
 *
 * The page and this route call the same `serveDiagramFragment`, so a
 * JS-free navigation and the enhancer's in-place fetch return the same
 * server-rendered SVG.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ handle: string; address: string }> },
): Promise<Response> {
  return serveDiagramFragment(request, await context.params);
}
