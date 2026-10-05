'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/** How long to wait for a slow tab's content before giving up on moving focus. */
const FOCUS_WAIT_MS = 15_000;

/**
 * After a tab change, move focus to the new tab's `<h2>` (#461) so a
 * screen-reader user hears that the content changed and a keyboard user
 * continues from the top of it, not from the tab they just activated.
 *
 * The route's `loading.tsx` (#459) means the path can change before the new
 * tab has rendered: for a moment the container holds a skeleton with no
 * `<h2>`. Looking once, at the path change, would find nothing and drop the
 * move for good. So the move is remembered and made as soon as an `<h2>`
 * appears in the container, however long that takes (up to `FOCUS_WAIT_MS`).
 *
 * Skips the first render: on a fresh page load focus belongs at the top of the
 * document, and stealing it to a heading would skip the skip link and nav.
 */
export function TabFocus({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const previous = useRef(pathname);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const root = container.current;
    if (!root) return;

    const focusHeading = (): boolean => {
      const heading = root.querySelector<HTMLElement>('h2');
      if (!heading) return false;
      // Headings are not focusable by default; -1 allows programmatic focus
      // without adding a tab stop.
      heading.setAttribute('tabindex', '-1');
      heading.focus();
      return true;
    };

    if (focusHeading()) return;

    // Content is still loading: wait for it. Cleaning up on the next path
    // change or unmount means a stale wait never steals focus later.
    const observer = new MutationObserver(() => {
      if (focusHeading()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    const giveUp = setTimeout(() => observer.disconnect(), FOCUS_WAIT_MS);
    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
    };
  }, [pathname]);

  return <div ref={container}>{children}</div>;
}
