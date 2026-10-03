'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * After a tab change, move focus to the new tab's `<h2>` (#461) so a
 * screen-reader user hears that the content changed and a keyboard user
 * continues from the top of it, not from the tab they just activated.
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
    const heading = container.current?.querySelector<HTMLElement>('h2');
    if (!heading) return;
    // Headings are not focusable by default; -1 allows programmatic focus
    // without adding a tab stop.
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }, [pathname]);

  return <div ref={container}>{children}</div>;
}
