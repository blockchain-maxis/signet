'use client';

import { useEffect } from 'react';
import { enhanceExpand } from '@signet/visualiser/interactive/expand';

export interface DiagramExpandProps {
  /** The id of the server-rendered region the fragment replaces. */
  region: string;
  /** The fragment route's path; the page's query is kept. */
  fragmentPath: string;
}

/**
 * Expands and collapses function groups without a full navigation (#502).
 * The links work without it: this only intercepts them and swaps the
 * server-drawn fragment in.
 */
export function DiagramExpand({ region, fragmentPath }: DiagramExpandProps) {
  useEffect(() => {
    const element = document.getElementById(region);
    if (!element) return;
    const controller = enhanceExpand({
      region: element,
      fragmentUrl: (url) => `${fragmentPath}${url.search}`,
    });
    return () => controller.destroy();
  }, [region, fragmentPath]);
  return null;
}
