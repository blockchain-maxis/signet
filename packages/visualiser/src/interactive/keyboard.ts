/**
 * @file @signet/visualiser/interactive — keyboard navigation across the diagram (#501).
 *
 * Every node is an `<a>` (or `<g>` when not linkable), so it is already in the tab order.
 * On a large contract, though, tabbing through 50 nodes to reach the one you want is
 * unusable. Arrow-key navigation along the diagram's own structure fixes this:
 * move within a column, and move along edges to connected nodes.
 *
 * Scope:
 * - Roving tabindex (a single tab stop for the diagram).
 * - ↑/↓ move within a column (clamped within column boundaries).
 * - → follows the first outgoing edge (then cycles through edges on repeat).
 * - ← goes back along the incoming edge.
 * - Home/End jump to the first/last node.
 * - Enter follows the link.
 * - A visible focus ring using `--viz-focus`, at least 2px, with a shape offset (not colour alone).
 * - A "Keyboard: arrows move, Enter opens" hint, shown on focus, visually subtle and
 *   announced once via `aria-describedby`.
 *
 * Framework-free DOM progressive enhancement with full teardown.
 */

export const KEYBOARD_CLASSES = {
  focused: 'viz-node--focused',
  hint: 'viz-keyboard-hint',
  hintVisible: 'viz-keyboard-hint--visible',
} as const;

export const KEYBOARD_HINT_TEXT = 'Keyboard: arrows move, Enter opens';

export interface EnhanceKeyboardOptions {
  /** Optional container element where the hint element is appended. */
  container?: Element | null;
  /** Custom hint text if desired. Defaults to `KEYBOARD_HINT_TEXT`. */
  hintText?: string;
  /** Tolerance in pixels to group nodes into the same column by x position. Default 20. */
  columnTolerance?: number;
}

export interface EdgeRef {
  from: string;
  to: string;
}

export interface NodePosition {
  x: number;
  y: number;
}

/** Reads a node element's position, falling back to SVG rect attributes when getBoundingClientRect is 0. */
export function getNodePosition(element: Element): NodePosition {
  const r = element.getBoundingClientRect?.();
  if (r && (r.left !== 0 || r.top !== 0 || r.width !== 0 || r.height !== 0)) {
    return { x: r.left, y: r.top };
  }
  const rect = element.querySelector?.('rect') ?? element;
  const x = parseFloat(rect.getAttribute?.('x') ?? '0');
  const y = parseFloat(rect.getAttribute?.('y') ?? '0');
  return { x: Number.isNaN(x) ? 0 : x, y: Number.isNaN(y) ? 0 : y };
}

/** Groups nodes into vertical columns ordered left-to-right, with nodes ordered top-to-bottom. */
export function groupNodesIntoColumns(
  nodes: readonly Element[],
  tolerance = 20,
): Element[][] {
  if (nodes.length === 0) return [];

  const spatials = nodes.map((element) => {
    const pos = getNodePosition(element);
    return {
      element,
      id: element.getAttribute('data-node-id') ?? '',
      x: pos.x,
      y: pos.y,
    };
  });

  // Sort primarily by x to cluster into columns, secondarily by y
  spatials.sort((a, b) => a.x - b.x || a.y - b.y);

  const columnClusters: (typeof spatials)[] = [];
  for (const item of spatials) {
    const lastCluster = columnClusters[columnClusters.length - 1];
    if (lastCluster && Math.abs(item.x - lastCluster[0]!.x) <= tolerance) {
      lastCluster.push(item);
    } else {
      columnClusters.push([item]);
    }
  }

  // Sort each column top to bottom
  for (const cluster of columnClusters) {
    cluster.sort((a, b) => a.y - b.y);
  }

  return columnClusters.map((cluster) => cluster.map((item) => item.element));
}

/** Builds outgoing and incoming edge maps for fast graph traversal. */
export function buildNavigationMaps(edges: readonly EdgeRef[]): {
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
} {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const edge of edges) {
    if (!edge.from || !edge.to) continue;

    const outList = outgoing.get(edge.from);
    if (!outList) outgoing.set(edge.from, [edge.to]);
    else if (!outList.includes(edge.to)) outList.push(edge.to);

    const inList = incoming.get(edge.to);
    if (!inList) incoming.set(edge.to, [edge.from]);
    else if (!inList.includes(edge.from)) inList.push(edge.from);
  }

  return { outgoing, incoming };
}

let hintSeq = 0;

/**
 * Enhances an SVG diagram with roving tabindex and keyboard navigation.
 *
 * Returns a teardown function that restores tabindices and cleans up listeners and DOM elements.
 */
export function enhanceKeyboard(
  svg: SVGSVGElement,
  options: EnhanceKeyboardOptions = {},
): () => void {
  if (svg.getAttribute('data-keyboard-enhanced') === 'true') {
    return () => {};
  }
  svg.setAttribute('data-keyboard-enhanced', 'true');

  const doc = svg.ownerDocument;
  const nodeElements = Array.from(svg.querySelectorAll<Element>('[data-node-id]'));
  if (nodeElements.length === 0) {
    return () => {
      svg.removeAttribute('data-keyboard-enhanced');
    };
  }

  const edgeElements = Array.from(svg.querySelectorAll<Element>('[data-edge-from]'));
  const edges: EdgeRef[] = edgeElements.map((el) => ({
    from: el.getAttribute('data-edge-from') ?? '',
    to: el.getAttribute('data-edge-to') ?? '',
  }));

  const { outgoing: outgoingMap, incoming: incomingMap } = buildNavigationMaps(edges);

  const nodeMap = new Map<string, Element>();
  for (const el of nodeElements) {
    const id = el.getAttribute('data-node-id');
    if (id) nodeMap.set(id, el);
  }

  const columns = groupNodesIntoColumns(nodeElements, options.columnTolerance);
  const allNodes = columns.flat();

  const nodeColumnIdx = new Map<Element, number>();
  const nodeRowIdx = new Map<Element, number>();
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c]!;
    for (let r = 0; r < col.length; r++) {
      const el = col[r]!;
      nodeColumnIdx.set(el, c);
      nodeRowIdx.set(el, r);
    }
  }

  // Save original tabindices for clean restoration on teardown
  const originalTabindices = new Map<Element, string | null>();
  for (const el of nodeElements) {
    originalTabindices.set(el, el.getAttribute('tabindex'));
  }

  // Roving tabindex: single tab stop for the diagram initially on the first node
  let activeNode: Element = allNodes[0]!;
  activeNode.setAttribute('tabindex', '0');
  for (let i = 1; i < allNodes.length; i++) {
    allNodes[i]!.setAttribute('tabindex', '-1');
  }

  // Keyboard navigation hint element
  const hintText = options.hintText ?? KEYBOARD_HINT_TEXT;
  const hint = doc.createElement('div');
  const hintId = `viz-keyboard-hint-${++hintSeq}`;
  hint.id = hintId;
  hint.className = KEYBOARD_CLASSES.hint;
  hint.textContent = hintText;
  hint.hidden = true;
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');

  const host = options.container ?? svg.parentElement ?? doc.body;
  host.appendChild(hint);

  // Announced once via aria-describedby when entering the diagram
  const initialDesc = activeNode.getAttribute('aria-describedby');
  activeNode.setAttribute(
    'aria-describedby',
    initialDesc ? `${initialDesc} ${hintId}` : hintId,
  );

  let hintAnnounced = false;
  const markHintAnnounced = () => {
    if (hintAnnounced) return;
    hintAnnounced = true;
    const desc = allNodes[0]?.getAttribute('aria-describedby');
    if (desc) {
      const updated = desc
        .split(/\s+/)
        .filter((id) => id !== hintId)
        .join(' ');
      if (updated) allNodes[0]?.setAttribute('aria-describedby', updated);
      else allNodes[0]?.removeAttribute('aria-describedby');
    }
  };

  const cycleMap = new Map<string, number>();
  const incomingHistory = new Map<string, string>();

  let focusing = false;
  const focusNode = (target: Element) => {
    const isAlreadyFocused = activeNode === target && target.getAttribute('tabindex') === '0';
    if (activeNode && activeNode !== target) {
      activeNode.setAttribute('tabindex', '-1');
      activeNode.classList.remove(KEYBOARD_CLASSES.focused);
    }
    activeNode = target;
    activeNode.setAttribute('tabindex', '0');
    activeNode.classList.add(KEYBOARD_CLASSES.focused);

    hint.hidden = false;
    hint.classList.add(KEYBOARD_CLASSES.hintVisible);

    if (!isAlreadyFocused && !focusing && typeof (target as HTMLElement).focus === 'function') {
      try {
        focusing = true;
        (target as HTMLElement).focus();
      } finally {
        focusing = false;
      }
    }
  };

  const listeners: Array<[Element, string, EventListener]> = [];

  const handleKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    const current = activeNode;
    if (!current) return;

    switch (e.key) {
      case 'ArrowUp': {
        const c = nodeColumnIdx.get(current);
        const r = nodeRowIdx.get(current);
        if (c !== undefined && r !== undefined) {
          const col = columns[c]!;
          const nextR = Math.max(0, r - 1);
          focusNode(col[nextR]!);
          e.preventDefault();
        }
        break;
      }
      case 'ArrowDown': {
        const c = nodeColumnIdx.get(current);
        const r = nodeRowIdx.get(current);
        if (c !== undefined && r !== undefined) {
          const col = columns[c]!;
          const nextR = Math.min(col.length - 1, r + 1);
          focusNode(col[nextR]!);
          e.preventDefault();
        }
        break;
      }
      case 'ArrowRight': {
        const id = current.getAttribute('data-node-id');
        const targets = id ? (outgoingMap.get(id) ?? []) : [];
        if (targets.length > 0) {
          const cycle = cycleMap.get(id!) ?? 0;
          const targetId = targets[cycle % targets.length]!;
          cycleMap.set(id!, cycle + 1);
          incomingHistory.set(targetId, id!);
          const targetEl = nodeMap.get(targetId);
          if (targetEl) {
            focusNode(targetEl);
            e.preventDefault();
          }
        }
        break;
      }
      case 'ArrowLeft': {
        const id = current.getAttribute('data-node-id');
        let prevId: string | undefined;
        if (id && incomingHistory.has(id)) {
          prevId = incomingHistory.get(id);
        } else if (id) {
          const sources = incomingMap.get(id) ?? [];
          if (sources.length > 0) prevId = sources[0];
        }
        if (prevId) {
          const prevEl = nodeMap.get(prevId);
          if (prevEl) {
            focusNode(prevEl);
            e.preventDefault();
          }
        }
        break;
      }
      case 'Home': {
        if (allNodes.length > 0) {
          focusNode(allNodes[0]!);
          e.preventDefault();
        }
        break;
      }
      case 'End': {
        if (allNodes.length > 0) {
          focusNode(allNodes[allNodes.length - 1]!);
          e.preventDefault();
        }
        break;
      }
      case 'Enter': {
        if (current.tagName.toLowerCase() === 'a' || current.hasAttribute('href')) {
          if (typeof (current as HTMLElement).click === 'function') {
            (current as HTMLElement).click();
          }
        }
        break;
      }
    }
  };

  const handleFocus = (nodeEl: Element) => () => {
    focusNode(nodeEl);
    markHintAnnounced();
  };

  const handleBlur = (nodeEl: Element) => () => {
    nodeEl.classList.remove(KEYBOARD_CLASSES.focused);
    // Hide hint if focus left the diagram
    setTimeout?.(() => {
      if (!doc.activeElement || !svg.contains(doc.activeElement)) {
        hint.hidden = true;
        hint.classList.remove(KEYBOARD_CLASSES.hintVisible);
      }
    }, 0);
  };

  for (const nodeEl of nodeElements) {
    const onFocus = handleFocus(nodeEl);
    const onBlur = handleBlur(nodeEl);

    nodeEl.addEventListener('keydown', handleKeyDown);
    nodeEl.addEventListener('focus', onFocus);
    nodeEl.addEventListener('blur', onBlur);

    listeners.push(
      [nodeEl, 'keydown', handleKeyDown],
      [nodeEl, 'focus', onFocus],
      [nodeEl, 'blur', onBlur],
    );
  }

  return () => {
    for (const [el, type, handler] of listeners) {
      el.removeEventListener(type, handler);
    }

    // Restore original tabindices
    for (const [el, original] of originalTabindices) {
      if (original === null) {
        el.removeAttribute('tabindex');
      } else {
        el.setAttribute('tabindex', original);
      }
      el.classList.remove(KEYBOARD_CLASSES.focused);
    }

    // Clean up hint
    const desc = allNodes[0]?.getAttribute('aria-describedby');
    if (desc) {
      const updated = desc
        .split(/\s+/)
        .filter((id) => id !== hintId)
        .join(' ');
      if (updated) allNodes[0]?.setAttribute('aria-describedby', updated);
      else allNodes[0]?.removeAttribute('aria-describedby');
    }
    hint.remove();

    svg.removeAttribute('data-keyboard-enhanced');
  };
}
