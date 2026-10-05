'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/** How long to wait for a slow tab's content before giving up on moving focus. */
const FOCUS_WAIT_MS = 15_000;

/** The element a `#fragment` in the URL names, or null when there is none (yet). */
function fragmentTarget(): HTMLElement | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // A malformed escape: use the text as written.
  }
  return document.getElementById(id);
}

/**
 * Focus the section a `#fragment` names (#472). The browser's own fragment
 * focus is unreliable here: a link into another tab is a full navigation whose
 * content streams in after the browser has already looked for the target, and
 * a target inside a closed `<details>` (the "unused types" group) is not
 * rendered at all. So this opens any closed `<details>` around the target and
 * focuses it, which also scrolls it into view.
 */
function focusFragment(): boolean {
  const target = fragmentTarget();
  if (!target) return false;
  for (let el = target.parentElement; el; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement) el.open = true;
  }
  // Sections carry tabindex=-1 already; this covers any other target.
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus();
  return true;
}

/** Focus the tab's `<h2>`. Headings are not focusable by default; -1 allows programmatic focus without a tab stop. */
function focusHeading(root: HTMLElement): boolean {
  const heading = root.querySelector<HTMLElement>('h2');
  if (!heading) return false;
  heading.setAttribute('tabindex', '-1');
  heading.focus();
  return true;
}

/**
 * Run `attempt` now, and again as the container changes until it succeeds or
 * `FOCUS_WAIT_MS` passes. Returns the cleanup, so a stale wait never steals
 * focus after the next navigation.
 */
function whenReady(root: HTMLElement, attempt: () => boolean): (() => void) | undefined {
  if (attempt()) return undefined;
  const observer = new MutationObserver(() => {
    if (attempt()) observer.disconnect();
  });
  observer.observe(root, { childList: true, subtree: true });
  const giveUp = setTimeout(() => observer.disconnect(), FOCUS_WAIT_MS);
  return () => {
    observer.disconnect();
    clearTimeout(giveUp);
  };
}

/**
 * Move focus where a keyboard or screen-reader user needs it after navigating
 * inside a contract page.
 *
 * After a tab change (#461) focus goes to the new tab's `<h2>`, so the user
 * hears that the content changed and continues from the top of it, not from
 * the tab they just activated. The route's `loading.tsx` (#459) means the path
 * can change before the new tab has rendered, so the move is remembered and
 * made as soon as the `<h2>` appears, however long that takes.
 *
 * When the URL names a fragment (`…/types#type-Config`, #472) focus goes to
 * that section instead, whether it arrived by a tab change, a fresh page load
 * (a type link is a full navigation) or a same-page hash change.
 *
 * A fresh load with no fragment leaves focus at the top of the document:
 * stealing it to a heading would skip the skip link and nav.
 */
export function TabFocus({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const previous = useRef(pathname);
  const mounted = useRef(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const firstRender = !mounted.current;
    mounted.current = true;
    const pathChanged = previous.current !== pathname;
    previous.current = pathname;
    const root = container.current;
    if (!root) return;

    const hasFragment = window.location.hash.length > 1;
    if (hasFragment) return whenReady(root, focusFragment);
    if (firstRender || !pathChanged) return;
    return whenReady(root, () => focusHeading(root));
  }, [pathname]);

  // A same-page `#fragment` link: the browser focuses a tabindex=-1 target on
  // its own, but not one inside a closed <details>.
  useEffect(() => {
    const onHashChange = () => {
      focusFragment();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return <div ref={container}>{children}</div>;
}
