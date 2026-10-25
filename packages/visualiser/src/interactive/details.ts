/**
 * @file @signet/visualiser/interactive — hover and focus detail card (#500).
 *
 * Progressive enhancement over a rendered contract diagram. The page ships a
 * plain SVG with native `<title>` tooltips; this module adds a styled HTML
 * detail card that appears on hover **and** keyboard focus, so a reader who
 * cannot use a mouse gets the full signature, doc comment and types too. With
 * JS off nothing here runs and the native tooltip is what was always there.
 *
 * Framework-free on purpose: the web contract page mounts it from a
 * `useEffect`, and the local `signet dev` UI (#580) reuses it as-is. It is the
 * only part of this package that touches the DOM, which is why the `lib` here
 * is separate from the pure core's (see `tsconfig.interactive.json`).
 *
 * Element contract (produced by `renderDiagramSvg`):
 * - each node container carries `data-node-id="<id>"`;
 * - each edge carries `data-edge-from` / `data-edge-to`.
 *
 * The card never covers the node it describes, is clamped to the viewport so
 * it stays on screen at phone widths, is `role="tooltip"` linked with
 * `aria-describedby` while open, and is dismissed with Escape. Nodes with no
 * entry in `details` are left entirely alone, so their native `<title>` still
 * works.
 */

/** One node's detail-card content. Everything but the signature is optional. */
export interface NodeDetails {
  /** Full signature, e.g. `transfer(from: Address, to: Address) -> ()`. */
  signature: string;
  /** Human-readable doc comment, if the build carried one. */
  doc?: string;
  /** Names/types used by the signature, already resolved by the page. */
  types?: readonly string[];
  /** Phase-2/3 marks (e.g. "writes state"), shown later. */
  marks?: readonly string[];
}

/**
 * The detail-card payload, a plain JSON map keyed by node id. The page
 * serialises this next to the SVG (and, on the server, would build it from the
 * same `DiagramModel` the SVG was rendered from), so the enhancer needs no
 * knowledge of the spec.
 */
export type DetailsData = Record<string, NodeDetails>;

/** A labelled row of the card. */
export interface DetailSection {
  label: string;
  value: string;
}

/** Pixel rectangle in viewport coordinates (the shape `getBoundingClientRect` returns). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Viewport size the card must stay inside. */
export interface Viewport {
  width: number;
  height: number;
}

/** Which side of the node the card ended up on. */
export type PlacementSide = 'right' | 'left' | 'below' | 'above';

export interface Placement {
  left: number;
  top: number;
  side: PlacementSide;
}

/** The classes the enhancer toggles; styled from `--viz-*` in `details.css`. */
export const DETAILS_CLASSES = {
  card: 'viz-details-card',
  active: 'viz-node--active',
  related: 'viz-node--related',
  incident: 'viz-edge--incident',
} as const;

/** Distance, in px, held between the node and the card, and from the viewport edge. */
export const DEFAULT_GAP = 8;

/** Minimal edge identity the pure helpers work on. */
export interface EdgeRef {
  from: string;
  to: string;
}

/**
 * Builds the card's rows from a node's details, dropping empty sections so a
 * node without a doc comment does not render an empty "Doc" row.
 */
export function detailSections(details: NodeDetails): DetailSection[] {
  const sections: DetailSection[] = [{ label: 'Signature', value: details.signature }];
  if (details.types && details.types.length > 0) {
    sections.push({ label: 'Types', value: details.types.join(', ') });
  }
  if (details.doc && details.doc.trim() !== '') {
    sections.push({ label: 'Doc', value: details.doc });
  }
  if (details.marks && details.marks.length > 0) {
    sections.push({ label: 'Marks', value: details.marks.join(', ') });
  }
  return sections;
}

/**
 * The nodes adjacent to `nodeId` and the edges incident to it, from the flat
 * edge list. Self-loops count as incident but not as a neighbour, exactly once.
 */
export function relatedTo(
  nodeId: string,
  edges: readonly EdgeRef[],
): { neighbours: string[]; incident: EdgeRef[] } {
  const neighbours = new Set<string>();
  const incident: EdgeRef[] = [];
  for (const edge of edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    incident.push(edge);
    const other = edge.from === nodeId ? edge.to : edge.from;
    if (other !== nodeId) neighbours.add(other);
  }
  return { neighbours: [...neighbours], incident };
}

/**
 * Places the card beside the node without covering it, and clamps it so it
 * stays fully on screen. Pure, so the awkward cases (phone widths, an edge
 * node, a card taller than the viewport) are unit-testable without a browser.
 *
 * Order of preference: right of the node, then left, then below, then above.
 * A side placement sits entirely outside the node's horizontal span; the
 * vertical placements sit entirely outside its vertical span — so the card
 * never overlaps the node it describes, on any side.
 */
export function placeCard(
  node: Rect,
  card: { width: number; height: number },
  viewport: Viewport,
  gap: number = DEFAULT_GAP,
): Placement {
  const maxLeft = Math.max(gap, viewport.width - card.width - gap);
  const maxTop = Math.max(gap, viewport.height - card.height - gap);
  const clamp = (value: number, max: number) => Math.min(Math.max(value, gap), max);

  const fitsRight = node.right + gap + card.width <= viewport.width - gap;
  if (fitsRight) {
    return { left: node.right + gap, top: clamp(node.top, maxTop), side: 'right' };
  }

  const fitsLeft = node.left - gap - card.width >= gap;
  if (fitsLeft) {
    return { left: node.left - gap - card.width, top: clamp(node.top, maxTop), side: 'left' };
  }

  const below = node.bottom + gap;
  const above = node.top - gap - card.height;
  const left = clamp(node.left, maxLeft);
  if (below + card.height <= viewport.height - gap) {
    return { left, top: below, side: 'below' };
  }
  if (above >= gap) {
    return { left, top: above, side: 'above' };
  }
  // Neither fits cleanly (card taller than the viewport): pin below the node's
  // top edge, clamped, which still does not cover the node's own box.
  return { left, top: clamp(below, maxTop), side: 'below' };
}

export interface EnhanceDetailsOptions {
  /** Gap between node and card, and from the viewport edge. Defaults to `DEFAULT_GAP`. */
  gap?: number;
  /** Optional callback to render additional actions/footer into the card. */
  renderFooter?: (card: HTMLElement, nodeId: string) => void;
}

let cardSeq = 0;

/** Reads an element's viewport rect, tolerating a zero rect in older engines. */
function rectOf(element: Element): Rect {
  const r = element.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

/**
 * Enhances a rendered diagram in place. Returns a teardown function that
 * removes every listener, the card and the highlight classes — call it from a
 * `useEffect` cleanup so a re-render does not stack enhancers.
 *
 * Idempotent per `<svg>`: a second call on the same element is a no-op that
 * returns a no-op teardown.
 */
export function enhanceDetails(
  svg: SVGSVGElement,
  data: DetailsData,
  options: EnhanceDetailsOptions = {},
): () => void {
  if (svg.getAttribute('data-details-enhanced') === 'true') {
    return () => {};
  }
  svg.setAttribute('data-details-enhanced', 'true');

  const doc = svg.ownerDocument;
  const win = doc.defaultView;
  const gap = options.gap ?? DEFAULT_GAP;

  const nodeElements = Array.from(svg.querySelectorAll<Element>('[data-node-id]'));
  const edgeElements = Array.from(svg.querySelectorAll<Element>('[data-edge-from]'));
  const edges: EdgeRef[] = edgeElements.map((el) => ({
    from: el.getAttribute('data-edge-from') ?? '',
    to: el.getAttribute('data-edge-to') ?? '',
  }));

  // The card lives outside the `<svg>` as an absolutely-positioned HTML
  // element. `position: fixed` lets it use viewport coordinates directly, so
  // `getBoundingClientRect` values need no scroll offset.
  const card = doc.createElement('div');
  const cardId = `viz-details-card-${++cardSeq}`;
  card.id = cardId;
  card.className = DETAILS_CLASSES.card;
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  card.style.position = 'fixed';
  card.style.zIndex = '60';
  const host = svg.parentElement ?? doc.body;
  host.appendChild(card);

  let active: Element | null = null;

  const clearHighlights = () => {
    for (const el of nodeElements) {
      el.classList.remove(DETAILS_CLASSES.active, DETAILS_CLASSES.related);
    }
    for (const el of edgeElements) {
      el.classList.remove(DETAILS_CLASSES.incident);
    }
  };

  const close = () => {
    if (active) active.removeAttribute('aria-describedby');
    active = null;
    card.hidden = true;
    clearHighlights();
  };

  const open = (nodeEl: Element) => {
    const nodeId = nodeEl.getAttribute('data-node-id');
    const details = nodeId ? data[nodeId] : undefined;
    if (!details) return;

    if (active && active !== nodeEl) {
      active.removeAttribute('aria-describedby');
      clearHighlights();
    }
    active = nodeEl;

    // Rebuild the card body. Text goes through `textContent`, never innerHTML,
    // so a doc comment can never inject markup.
    card.replaceChildren();
    for (const section of detailSections(details)) {
      const row = doc.createElement('div');
      row.className = 'viz-details-card__row';
      const label = doc.createElement('span');
      label.className = 'viz-details-card__label';
      label.textContent = section.label;
      const value = doc.createElement('span');
      value.className = 'viz-details-card__value';
      value.textContent = section.value;
      row.append(label, value);
      card.appendChild(row);
    }

    // The read/write mark's example evidence (#512), from the node itself:
    // the transaction that showed the write, linked when the page gave a
    // link, and only to http(s).
    const tx = nodeEl.getAttribute('data-mark-tx');
    if (tx) {
      const row = doc.createElement('div');
      row.className = 'viz-details-card__row';
      const label = doc.createElement('span');
      label.className = 'viz-details-card__label';
      label.textContent = 'Evidence';
      const value = doc.createElement('span');
      value.className = 'viz-details-card__value';
      const ledger = nodeEl.getAttribute('data-mark-ledger');
      const text = `write in tx ${tx.slice(0, 8)}…${ledger ? ` at ledger ${ledger}` : ''}`;
      const href = nodeEl.getAttribute('data-mark-href');
      if (href && /^https?:\/\//.test(href)) {
        const link = doc.createElement('a');
        link.href = href;
        link.rel = 'noopener noreferrer';
        link.target = '_blank';
        link.textContent = text;
        value.appendChild(link);
      } else {
        value.textContent = text;
      }
      row.append(label, value);
      card.appendChild(row);
    }

    if (options.renderFooter && nodeId) {
      options.renderFooter(card, nodeId);
    }

    nodeEl.setAttribute('aria-describedby', cardId);
    card.hidden = false;

    const placement = placeCard(
      rectOf(nodeEl),
      { width: card.offsetWidth, height: card.offsetHeight },
      { width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 },
      gap,
    );
    card.style.left = `${placement.left}px`;
    card.style.top = `${placement.top}px`;
    card.setAttribute('data-side', placement.side);

    nodeEl.classList.add(DETAILS_CLASSES.active);
    if (nodeId) {
      const { neighbours, incident } = relatedTo(nodeId, edges);
      for (const el of nodeElements) {
        const id = el.getAttribute('data-node-id');
        if (id && neighbours.includes(id)) el.classList.add(DETAILS_CLASSES.related);
      }
      for (let i = 0; i < edgeElements.length; i++) {
        const edge = edges[i];
        if (edge && incident.some((e) => e.from === edge.from && e.to === edge.to)) {
          edgeElements[i]?.classList.add(DETAILS_CLASSES.incident);
        }
      }
    }
  };

  const listeners: Array<[Element, string, EventListener]> = [];
  const onLeave: EventListener = () => close();
  for (const nodeEl of nodeElements) {
    const nodeId = nodeEl.getAttribute('data-node-id');
    if (!nodeId || !data[nodeId]) continue;
    // Only nodes with a card need to be reachable. Nodes that already are
    // (an `<a href>`) are left as they are; a bare `<g>` gets a tab stop.
    if (nodeEl.tagName.toLowerCase() !== 'a' && !nodeEl.hasAttribute('tabindex')) {
      nodeEl.setAttribute('tabindex', '0');
    }
    // Per-node closures rather than `event.currentTarget`: no reliance on the
    // global `Element` constructor at runtime, so the interaction logic runs
    // under a plain DOM double in tests as well as a browser.
    const enter: EventListener = () => open(nodeEl);
    const handlers: Array<[string, EventListener]> = [
      ['mouseenter', enter],
      ['mouseleave', onLeave],
      ['focus', enter],
      ['blur', onLeave],
    ];
    for (const [type, handler] of handlers) {
      nodeEl.addEventListener(type, handler);
      listeners.push([nodeEl, type, handler]);
    }
  }
  // Escape from anywhere dismisses, so a reader who tabs to the card's node and
  // then clicks elsewhere can still close it.
  const docKeyDown: EventListener = (event) => {
    if ((event as KeyboardEvent).key === 'Escape') close();
  };
  doc.addEventListener('keydown', docKeyDown);

  return () => {
    for (const [el, type, handler] of listeners) el.removeEventListener(type, handler);
    doc.removeEventListener('keydown', docKeyDown);
    close();
    card.remove();
    svg.removeAttribute('data-details-enhanced');
  };
}
