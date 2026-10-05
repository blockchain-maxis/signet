import { renderSpecWarnings, specWarnings } from '@/lib/docs-state';

/**
 * The decoder's warnings (#432) as a small muted list under the provenance
 * strip (#470). Renders nothing when there are none.
 */
export function SpecWarnings({ warnings }: { warnings?: readonly string[] }) {
  return renderSpecWarnings(specWarnings({ warnings }));
}
