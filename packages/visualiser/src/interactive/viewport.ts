/**
 * @file @signet/visualiser/interactive — bounded viewport, zoom steps and pan (#504).
 *
 * Framework-free DOM enhancer for contract diagrams (design §3).
 *
 * Design principles:
 * - "Bound the viewport, don't autofit": diagrams scroll inside a bounded
 *   region (max-height: 70vh, overflow: auto), so large surfaces never shrink
 *   to an illegible thumbnail.
 * - Text never drops below MIN_TEXT_PX (12px). Zoom steps are discrete, bounded
 *   at the bottom by minScale = MIN_TEXT_PX / baseFontPx and at the top by 1.5.
 * - No animation: transitions are zero-duration (design §2.3 no motion).
 * - Keyboard accessible: role="region", tabindex="0", aria-label, keyboard
 *   shortcuts (+, -, 0 to reset), and focusing a node scrolls it into view.
 * - Pointer-driven drag to pan.
 */

import { MIN_TEXT_PX } from '../metrics.ts';

export const DEFAULT_BASE_FONT_PX = 14;
export const DEFAULT_MAX_SCALE = 1.5;
export const DEFAULT_VIEWPORT_LABEL = 'Contract diagram viewport';

export const VIEWPORT_CLASSES = {
  container: 'viz-viewport',
  controls: 'viz-viewport-controls',
  button: 'viz-viewport-btn',
  zoomOut: 'viz-viewport-btn--zoom-out',
  zoomReset: 'viz-viewport-btn--zoom-reset',
  zoomIn: 'viz-viewport-btn--zoom-in',
  dragging: 'viz-viewport--dragging',
} as const;

export interface EnhanceViewportOptions {
  /** Base font size of diagram node labels in px. Defaults to 14. */
  baseFontPx?: number;
  /** Maximum scale factor. Defaults to 1.5. */
  maxScale?: number;
  /** Explicit zoom steps. Defaults to [minScale, 1.0, 1.25, 1.5]. */
  steps?: number[];
  /** Accessible label for the viewport scroll region. */
  ariaLabel?: string;
  /** Optional custom container/host for mounting zoom buttons. */
  controlsHost?: HTMLElement;
  /** Callback fired whenever the zoom scale changes. */
  onZoomChange?: (scale: number, stepIndex: number) => void;
}

export interface ViewportController {
  /** Teardown function to remove listeners and injected controls. */
  (): void;
  teardown: () => void;
  getScale: () => number;
  getStepIndex: () => number;
  getSteps: () => readonly number[];
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  setScale: (scale: number) => void;
}

/**
 * Computes discrete zoom steps from minScale up to maxScale (design §3).
 * minScale = MIN_TEXT_PX / baseFontPx.
 * Guarantees that at the smallest step, node text is rendered at >= MIN_TEXT_PX (12px).
 */
export function computeZoomSteps(
  baseFontPx: number = DEFAULT_BASE_FONT_PX,
  maxScale: number = DEFAULT_MAX_SCALE,
): number[] {
  const minScale = MIN_TEXT_PX / baseFontPx;
  const standardSteps = [minScale, 1.0, 1.25, maxScale];
  const steps: number[] = [];
  for (const s of standardSteps.sort((a, b) => a - b)) {
    if (s <= maxScale && (steps.length === 0 || Math.abs(s - steps[steps.length - 1]!) > 0.0001)) {
      steps.push(s);
    }
  }
  return steps;
}

/**
 * Enhances a diagram container element with a bounded viewport, discrete zoom controls,
 * pointer drag-to-pan, keyboard shortcuts (+/-/0), and auto-scroll on focused nodes.
 *
 * Idempotent per container. Returns a callable ViewportController that also acts
 * as a teardown function for use in useEffect cleanups.
 */
export function enhanceViewport(
  container: HTMLElement,
  options: EnhanceViewportOptions = {},
): ViewportController {
  const noopTeardown = (() => {}) as unknown as ViewportController;
  noopTeardown.teardown = () => {};
  noopTeardown.getScale = () => 1.0;
  noopTeardown.getStepIndex = () => 0;
  noopTeardown.getSteps = () => [1.0];
  noopTeardown.zoomIn = () => {};
  noopTeardown.zoomOut = () => {};
  noopTeardown.resetZoom = () => {};
  noopTeardown.setScale = () => {};

  if (container.getAttribute('data-viewport-enhanced') === 'true') {
    return noopTeardown;
  }
  container.setAttribute('data-viewport-enhanced', 'true');

  const doc = container.ownerDocument;
  const baseFontPx = options.baseFontPx ?? DEFAULT_BASE_FONT_PX;
  const maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;
  const steps = options.steps ?? computeZoomSteps(baseFontPx, maxScale);

  // Default to 1.0 (100% zoom)
  let defaultStepIndex = steps.findIndex((s) => Math.abs(s - 1.0) < 0.001);
  if (defaultStepIndex === -1) defaultStepIndex = 0;

  let currentStepIndex = defaultStepIndex;
  let currentScale = steps[currentStepIndex] ?? 1.0;

  // 1. Accessibility & container attributes
  container.classList.add(VIEWPORT_CLASSES.container);
  container.setAttribute('role', 'region');
  if (!container.hasAttribute('aria-label')) {
    container.setAttribute('aria-label', options.ariaLabel ?? DEFAULT_VIEWPORT_LABEL);
  }
  if (!container.hasAttribute('tabindex')) {
    container.setAttribute('tabindex', '0');
  }

  // Ensure bounded viewport CSS constraints
  container.style.overflow = 'auto';
  container.style.maxHeight = '70vh';
  container.style.maxWidth = '100%';
  container.style.boxSizing = 'border-box';
  container.style.position = 'relative';
  container.style.scrollBehavior = 'auto'; // Design §2.3: no motion

  // 2. Find diagram SVG
  const svg = container.querySelector<SVGSVGElement>('svg.contract-diagram, svg');

  // 3. Build zoom controls
  const controls = doc.createElement('div');
  controls.className = VIEWPORT_CLASSES.controls;
  controls.setAttribute('role', 'toolbar');
  controls.setAttribute('aria-label', 'Zoom controls');

  const btnZoomOut = doc.createElement('button');
  btnZoomOut.type = 'button';
  btnZoomOut.className = `${VIEWPORT_CLASSES.button} ${VIEWPORT_CLASSES.zoomOut}`;
  btnZoomOut.setAttribute('aria-label', 'Zoom out');
  btnZoomOut.setAttribute('data-action', 'zoom-out');
  btnZoomOut.textContent = '−';

  const btnZoomReset = doc.createElement('button');
  btnZoomReset.type = 'button';
  btnZoomReset.className = `${VIEWPORT_CLASSES.button} ${VIEWPORT_CLASSES.zoomReset}`;
  btnZoomReset.setAttribute('aria-label', 'Reset zoom to 100%');
  btnZoomReset.setAttribute('data-action', 'zoom-reset');
  btnZoomReset.textContent = '100%';

  const btnZoomIn = doc.createElement('button');
  btnZoomIn.type = 'button';
  btnZoomIn.className = `${VIEWPORT_CLASSES.button} ${VIEWPORT_CLASSES.zoomIn}`;
  btnZoomIn.setAttribute('aria-label', 'Zoom in');
  btnZoomIn.setAttribute('data-action', 'zoom-in');
  btnZoomIn.textContent = '+';

  controls.append(btnZoomOut, btnZoomReset, btnZoomIn);

  const controlsHost = options.controlsHost ?? container;
  controlsHost.prepend(controls);

  // 4. Apply scale
  const applyScale = (scale: number) => {
    currentScale = scale;
    container.setAttribute('data-zoom-scale', scale.toString());
    if (svg) {
      svg.style.transformOrigin = '0 0';
      svg.style.transform = `scale(${scale})`;
      svg.style.transition = 'none';
      svg.setAttribute('data-zoom-scale', scale.toString());
    }
    btnZoomOut.disabled = currentStepIndex <= 0;
    btnZoomIn.disabled = currentStepIndex >= steps.length - 1;
    options.onZoomChange?.(scale, currentStepIndex);
  };

  const zoomIn = () => {
    if (currentStepIndex < steps.length - 1) {
      currentStepIndex++;
      applyScale(steps[currentStepIndex]!);
    }
  };

  const zoomOut = () => {
    if (currentStepIndex > 0) {
      currentStepIndex--;
      applyScale(steps[currentStepIndex]!);
    }
  };

  const resetZoom = () => {
    currentStepIndex = defaultStepIndex;
    applyScale(steps[currentStepIndex]!);
  };

  const setScale = (scale: number) => {
    let closestIndex = 0;
    let closestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < steps.length; i++) {
      const diff = Math.abs(steps[i]! - scale);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIndex = i;
      }
    }
    currentStepIndex = closestIndex;
    applyScale(steps[currentStepIndex]!);
  };

  // Initial scale application
  applyScale(currentScale);

  // Button listeners
  btnZoomOut.addEventListener('click', zoomOut);
  btnZoomReset.addEventListener('click', resetZoom);
  btnZoomIn.addEventListener('click', zoomIn);

  // Keyboard navigation (+, -, 0 while region has focus)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomIn();
    } else if (event.key === '-' || event.key === '_' || event.key === '−') {
      event.preventDefault();
      zoomOut();
    } else if (event.key === '0') {
      event.preventDefault();
      resetZoom();
    }
  };
  container.addEventListener('keydown', onKeyDown);

  // Auto-scroll node into view on keyboard focus
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as Element | null;
    if (!target) return;
    const nodeEl = target.closest?.('[data-node-id]');
    if (nodeEl && typeof nodeEl.scrollIntoView === 'function') {
      nodeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  container.addEventListener('focusin', onFocusIn);

  // Pointer drag-to-pan
  let isPointerDown = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button') || target?.closest(`.${VIEWPORT_CLASSES.controls}`)) {
      return;
    }
    isPointerDown = true;
    hasMoved = false;
    startX = event.clientX;
    startY = event.clientY;
    startScrollLeft = container.scrollLeft;
    startScrollTop = container.scrollTop;

    if (typeof container.setPointerCapture === 'function') {
      try {
        container.setPointerCapture(event.pointerId);
      } catch {}
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!isPointerDown) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!hasMoved && Math.hypot(dx, dy) > 3) {
      hasMoved = true;
      container.classList.add(VIEWPORT_CLASSES.dragging);
    }
    if (hasMoved) {
      container.scrollLeft = startScrollLeft - dx;
      container.scrollTop = startScrollTop - dy;
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!isPointerDown) return;
    isPointerDown = false;
    container.classList.remove(VIEWPORT_CLASSES.dragging);
    if (typeof container.releasePointerCapture === 'function') {
      try {
        container.releasePointerCapture(event.pointerId);
      } catch {}
    }
    if (hasMoved) {
      const preventClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      container.addEventListener('click', preventClick, { capture: true, once: true });
    }
  };

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);

  // Teardown
  const teardown = () => {
    btnZoomOut.removeEventListener('click', zoomOut);
    btnZoomReset.removeEventListener('click', resetZoom);
    btnZoomIn.removeEventListener('click', zoomIn);
    container.removeEventListener('keydown', onKeyDown);
    container.removeEventListener('focusin', onFocusIn);
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('pointercancel', onPointerUp);
    controls.remove();
    container.removeAttribute('data-viewport-enhanced');
    container.classList.remove(VIEWPORT_CLASSES.container, VIEWPORT_CLASSES.dragging);
  };

  const controller = teardown as unknown as ViewportController;
  controller.teardown = teardown;
  controller.getScale = () => currentScale;
  controller.getStepIndex = () => currentStepIndex;
  controller.getSteps = () => steps;
  controller.zoomIn = zoomIn;
  controller.zoomOut = zoomOut;
  controller.resetZoom = resetZoom;
  controller.setScale = setScale;

  return controller;
}
