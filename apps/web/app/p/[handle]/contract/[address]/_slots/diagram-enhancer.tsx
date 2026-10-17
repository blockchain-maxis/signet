'use client';

import { useEffect } from 'react';
import { enhanceExpand } from '@signet/visualiser/interactive/expand';

/**
 * Progressive enhancement for the server-rendered diagram (#502).
 *
 * With JavaScript off this component never runs and the diagram's links
 * navigate normally. With it on, `enhanceExpand` intercepts those same links,
 * fetches the server fragment, swaps the SVG in place and updates the URL.
 */
export function DiagramEnhancer({ rootId }: { rootId: string }) {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    return enhanceExpand(root);
  }, [rootId]);
  return null;
}
