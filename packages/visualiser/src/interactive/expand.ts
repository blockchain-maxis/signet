/**
 * @file Expand and collapse function groups in place (#502).
 *
 * The server draws every expansion state from the URL (`?expand=pool`), and
 * a collapsed group is a plain link to the URL that expands it, so this
 * works without JavaScript. With it, this enhancer intercepts those links
 * (any `a[data-group-toggle]` in the region), fetches the server-drawn
 * fragment for the new state, swaps it in, puts focus back on the toggled
 * group's link, and replaces the URL, without a full navigation. Any
 * failure falls back to following the link.
 */

export interface EnhanceExpandOptions {
  /** The element whose contents the fragment replaces. */
  readonly region: HTMLElement;
  /** The fragment's URL for a page URL: the same query on the fragment route. */
  readonly fragmentUrl: (pageUrl: URL) => string;
  /** Default `globalThis.fetch`. */
  readonly fetch?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
  /** Default `location`/`history`; tests pass doubles. */
  readonly navigate?: (url: string) => void;
  readonly replaceUrl?: (url: string) => void;
  readonly baseUrl?: () => string;
  /** Called after a swap, with the group toggled. */
  readonly onSwap?: (group: string) => void;
}

export interface ExpandController {
  /** Toggle by following a link's URL; resolves once swapped (or navigated). */
  follow(href: string, group: string): Promise<void>;
  destroy(): void;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export function enhanceExpand(options: EnhanceExpandOptions): ExpandController {
  const { region } = options;
  const doFetch = options.fetch ?? ((url: string) => globalThis.fetch(url, { headers: { accept: 'text/html' } }));
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url));
  const replaceUrl =
    options.replaceUrl ?? ((url: string) => window.history.replaceState(window.history.state, '', url));
  const baseUrl = options.baseUrl ?? (() => window.location.href);
  let pending = 0;

  async function follow(href: string, group: string): Promise<void> {
    const url = new URL(href, baseUrl());
    const ticket = ++pending;
    try {
      const res = await doFetch(options.fragmentUrl(url));
      if (!res.ok) throw new Error('fragment unavailable');
      const html = await res.text();
      if (ticket !== pending) return; // a later toggle won
      region.innerHTML = html;
      replaceUrl(url.pathname + url.search + url.hash);
      // Focus stays on the group: its node while collapsed, its collapse
      // link once expanded.
      const target = region.querySelector<HTMLElement>(`[data-group-toggle="${cssEscape(group)}"]`);
      target?.focus();
      options.onSwap?.(group);
    } catch {
      navigate(url.toString());
    }
  }

  function onClick(event: Event) {
    const e = event as MouseEvent;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as Element | null)?.closest?.('a[data-group-toggle]');
    if (!link || !region.contains(link)) return;
    const href = link.getAttribute('href');
    const group = link.getAttribute('data-group-toggle');
    if (!href || !group) return;
    e.preventDefault();
    void follow(href, group);
  }

  region.addEventListener('click', onClick);
  return {
    follow,
    destroy() {
      region.removeEventListener('click', onClick);
    },
  };
}
