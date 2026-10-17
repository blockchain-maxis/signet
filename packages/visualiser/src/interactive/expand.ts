/**
 * @file @signet/visualiser/interactive — server-first group expand/collapse (#502).
 *
 * The page renders the diagram for the URL's state on the server. Every
 * collapsed group is one `<a>` to the URL that expands it, and every expanded
 * group's header is an `<a>` to the URL that collapses it, so the diagram
 * works with JavaScript disabled. This enhancer only makes those links feel
 * instant: it fetches the same server-rendered fragment, swaps the `<svg>` in
 * place, keeps focus on the toggled group, and `history.replaceState`s the
 * URL. A failed fetch falls back to a normal navigation, so the feature never
 * depends on this module.
 *
 * Framework-free on purpose: the web contract page mounts it from a
 * `useEffect`, and the local `signet dev` UI (#580) reuses it as-is.
 *
 * Element contract (produced by `renderDiagramSvg`):
 * - an expand control carries `data-expand-group="<name>"`;
 * - a collapse control carries `data-collapse-group="<name>"`;
 * - either also carries `data-group-toggle="<name>"`, the element to focus
 *   after the swap;
 * - an optional `[data-diagram-status]` live region receives a short update.
 */

/** The links the enhancer intercepts. */
export const GROUP_CONTROL_SELECTOR =
  'a[data-expand-group], a[data-collapse-group], a[data-group-toggle]';

/** Attribute selector for the control of one named group. */
export function groupToggleSelector(group: string): string {
  const escaped = group.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[data-group-toggle="${escaped}"]`;
}

/** Injectable seams; production passes none. */
export interface EnhanceExpandOptions {
  /** Fetch the server-rendered fragment for a URL. */
  fetchText?: (url: string) => Promise<string>;
  /** Parse a fragment into an `<svg>` owned by `doc`, or null when invalid. */
  parseSvg?: (markup: string, doc: Document) => SVGSVGElement | null;
  /** Swap the current SVG for the next one. */
  replaceSvg?: (current: Element, next: Element) => void;
  /** Move focus after the swap. */
  focus?: (element: Element) => void;
  /** URL update seam. */
  history?: Pick<History, 'replaceState'>;
  /** Full-navigation fallback when the fragment cannot be fetched or used. */
  navigate?: (url: string) => void;
}

function defaultFetchText(url: string): Promise<string> {
  return fetch(url, { headers: { Accept: 'image/svg+xml' } }).then((response) => {
    if (!response.ok) throw new Error(`diagram fragment failed: ${response.status}`);
    return response.text();
  });
}

function defaultParseSvg(markup: string, doc: Document): SVGSVGElement | null {
  const view = doc.defaultView as (Window & { DOMParser?: typeof DOMParser }) | null;
  const Parser = view?.DOMParser ?? (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Parser) return null;
  const parsed = new Parser().parseFromString(markup, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;
  const root = parsed.documentElement;
  if (!root || root.localName !== 'svg') return null;
  return doc.importNode
    ? (doc.importNode(root, true) as unknown as SVGSVGElement)
    : (root as unknown as SVGSVGElement);
}

function defaultFocus(element: Element): void {
  (element as HTMLElement).focus?.();
}

function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

/**
 * Enhance a diagram container in place.
 *
 * The listener sits on the container, not the `<svg>`, so replacing the SVG
 * keeps the enhancer working for every later state. Returns a teardown that
 * removes the listener and the busy marker.
 *
 * Idempotent per container: a second call is a no-op returning a no-op
 * teardown, so a re-render cannot stack handlers.
 */
export function enhanceExpand(container: Element, options: EnhanceExpandOptions = {}): () => void {
  if (container.getAttribute('data-expand-enhanced') === 'true') return () => {};
  container.setAttribute('data-expand-enhanced', 'true');

  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const fetchText = options.fetchText ?? defaultFetchText;
  const parseSvg = options.parseSvg ?? defaultParseSvg;
  const replaceSvg =
    options.replaceSvg ?? ((current: Element, next: Element) => current.replaceWith(next));
  const focus = options.focus ?? defaultFocus;
  const history = options.history ?? win?.history;
  const navigate = options.navigate ?? ((url: string) => win?.location.assign(url));
  let sequence = 0;

  const setBusy = (busy: boolean) => {
    if (busy) container.setAttribute('aria-busy', 'true');
    else container.removeAttribute('aria-busy');
  };

  const announce = (message: string) => {
    const status = container.querySelector('[data-diagram-status]');
    if (status) status.textContent = message;
  };

  const onClick = (event: Event) => {
    const mouse = event as MouseEvent;
    if (!isPlainClick(mouse)) return;
    const target = mouse.target as { closest?: (selector: string) => Element | null } | null;
    const link = target?.closest?.(GROUP_CONTROL_SELECTOR) ?? null;
    if (!link) return;

    const expandGroup = link.getAttribute('data-expand-group');
    const collapseGroup = link.getAttribute('data-collapse-group');
    const group = expandGroup ?? collapseGroup ?? link.getAttribute('data-group-toggle');
    const href = link.getAttribute('href');
    if (group === null || href === null) return;

    mouse.preventDefault();
    const current = ++sequence;
    setBusy(true);

    fetchText(href)
      .then((markup) => {
        if (current !== sequence) return;
        const next = parseSvg(markup, doc);
        const svg = container.querySelector('svg');
        if (!next || !svg) throw new Error('diagram fragment had no svg');
        replaceSvg(svg, next);
        const toggled = container.querySelector(groupToggleSelector(group));
        if (toggled) focus(toggled);
        history?.replaceState(null, '', href);
        announce(expandGroup !== null ? `Expanded ${group}.` : `Collapsed ${group}.`);
        setBusy(false);
      })
      .catch(() => {
        if (current !== sequence) return;
        setBusy(false);
        // The server-rendered URL always works, so let the browser take it.
        navigate(href);
      });
  };

  container.addEventListener('click', onClick);

  return () => {
    sequence += 1;
    container.removeEventListener('click', onClick);
    container.removeAttribute('data-expand-enhanced');
    setBusy(false);
  };
}
