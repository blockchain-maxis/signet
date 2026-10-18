/**
 * @file Browser-based PNG export for contract diagrams (#519).
 *
 * Renders a standalone SVG to an HTML Canvas at 2× scale, embedding a Latin
 * subset of IBM Plex Mono as a base64 @font-face so text renders cleanly in the
 * canvas without relying on system fallback fonts.
 */

import { VIZ_TOKENS, type VizTheme } from '../tokens.ts';
import { IBM_PLEX_MONO_BASE64 } from './font.ts';

export { IBM_PLEX_MONO_BASE64 } from './font.ts';

export const PNG_EXPORT_ERROR_MESSAGE = 'PNG export failed; download the SVG instead';

export interface SvgDimensions {
  width: number;
  height: number;
}

/**
 * Extracts width and height from an SVG element or string using viewBox or width/height attributes.
 */
export function parseSvgDimensions(svg: string | SVGSVGElement): SvgDimensions {
  if (typeof svg !== 'string') {
    const viewBox = svg.viewBox?.baseVal;
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      return { width: viewBox.width, height: viewBox.height };
    }
    const width = svg.width?.baseVal?.value || parseFloat(svg.getAttribute('width') || '0');
    const height = svg.height?.baseVal?.value || parseFloat(svg.getAttribute('height') || '0');
    if (width > 0 && height > 0) {
      return { width, height };
    }
    throw new Error(PNG_EXPORT_ERROR_MESSAGE);
  }

  // Parse viewBox from string
  const viewBoxMatch = svg.match(
    /\bviewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i,
  );
  if (viewBoxMatch) {
    const width = parseFloat(viewBoxMatch[3]!);
    const height = parseFloat(viewBoxMatch[4]!);
    if (!Number.isNaN(width) && !Number.isNaN(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  // Fallback to width and height attributes
  const widthMatch = svg.match(/\bwidth\s*=\s*["']\s*([-\d.]+)(?:px)?\s*["']/i);
  const heightMatch = svg.match(/\bheight\s*=\s*["']\s*([-\d.]+)(?:px)?\s*["']/i);
  if (widthMatch && heightMatch) {
    const width = parseFloat(widthMatch[1]!);
    const height = parseFloat(heightMatch[1]!);
    if (!Number.isNaN(width) && !Number.isNaN(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  throw new Error(PNG_EXPORT_ERROR_MESSAGE);
}

/**
 * Injects IBM Plex Mono @font-face definition into the SVG string for canvas rasterisation.
 */
export function embedFontInSvg(
  svgString: string,
  fontBase64: string = IBM_PLEX_MONO_BASE64,
): string {
  const fontFaceStyle = `@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  src: url('data:font/woff2;base64,${fontBase64}') format('woff2');
}
text, .label, .footer, .group-label {
  font-family: 'IBM Plex Mono', monospace !important;
}`;

  if (/<style[^>]*>/i.test(svgString)) {
    return svgString.replace(/<style([^>]*)>/i, `<style$1>\n${fontFaceStyle}\n`);
  }

  return svgString.replace(/(<svg[^>]*>)/i, `$1\n<defs><style>\n${fontFaceStyle}\n</style></defs>`);
}

/**
 * Enforces an explicit theme ('dark' or 'light') by appending specific token fill/stroke rules.
 */
export function applyExplicitThemeToSvg(svgString: string, theme: VizTheme): string {
  const t = VIZ_TOKENS[theme];
  const themeRules = `.canvas { fill: ${t.ground} !important; }
.node { fill: ${t.node} !important; stroke: ${t.edge} !important; }
.group { fill: none !important; stroke: ${t.edge} !important; }
.label { fill: ${t.nodeText} !important; }
.footer, .group-label { fill: ${t.muted} !important; }
.edge { fill: none !important; stroke: ${t.edge} !important; stroke-width: 1.5 !important; }
.arrow { fill: ${t.edge} !important; }`;

  if (/<style[^>]*>/i.test(svgString)) {
    return svgString.replace(/<style([^>]*)>/i, `<style$1>\n${themeRules}\n`);
  }

  return svgString.replace(/(<svg[^>]*>)/i, `$1\n<defs><style>\n${themeRules}\n</style></defs>`);
}

/**
 * Prepares an SVG for PNG rasterisation by embedding font and optionally applying an explicit theme.
 */
export function prepareSvgForPng(
  svg: string | SVGSVGElement,
  options: { theme?: VizTheme; fontBase64?: string } = {},
): { preparedSvg: string; dimensions: SvgDimensions } {
  const rawSvg = typeof svg === 'string' ? svg : new XMLSerializer().serializeToString(svg);
  const dimensions = parseSvgDimensions(rawSvg);

  let prepared = embedFontInSvg(rawSvg, options.fontBase64);
  if (options.theme) {
    prepared = applyExplicitThemeToSvg(prepared, options.theme);
  }

  return { preparedSvg: prepared, dimensions };
}

export interface RenderCanvasOptions {
  /** Canvas scaling factor. Defaults to 2 (2× scale). */
  scale?: number;
  /** Explicit theme override: 'dark' or 'light'. */
  theme?: VizTheme;
  /** Custom base64-encoded font data for @font-face if overriding default. */
  fontBase64?: string;
}

/**
 * Renders the standalone SVG to a Canvas element at the requested scale (default 2×).
 */
export async function renderSvgToCanvas(
  svg: string | SVGSVGElement,
  options: RenderCanvasOptions = {},
): Promise<HTMLCanvasElement> {
  const scale = options.scale ?? 2;
  const { preparedSvg, dimensions } = prepareSvgForPng(svg, {
    theme: options.theme,
    fontBase64: options.fontBase64,
  });

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preparedSvg)}`;
  const img = new Image();

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(PNG_EXPORT_ERROR_MESSAGE));
    img.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(dimensions.width * scale);
  canvas.height = Math.round(dimensions.height * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(PNG_EXPORT_ERROR_MESSAGE);
  }

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Converts a canvas element to a PNG Blob, throwing with the standard error if tainted or null.
 */
export async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  try {
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      try {
        canvas.toBlob((b) => resolve(b), 'image/png');
      } catch (err) {
        reject(err);
      }
    });

    if (!blob) {
      throw new Error(PNG_EXPORT_ERROR_MESSAGE);
    }

    return blob;
  } catch {
    throw new Error(PNG_EXPORT_ERROR_MESSAGE);
  }
}

export interface ExportPngOptions extends RenderCanvasOptions {
  fileName?: string;
  onError?: (error: Error, message: string) => void;
}

/**
 * Full export pipeline: renders SVG to canvas at 2× scale, converts to PNG blob, and downloads.
 */
export async function exportDiagramPng(
  svg: string | SVGSVGElement,
  options: ExportPngOptions = {},
): Promise<Blob> {
  try {
    const canvas = await renderSvgToCanvas(svg, options);
    const blob = await canvasToPngBlob(canvas);

    const fileName = options.fileName || 'diagram.png';
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

    return blob;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(PNG_EXPORT_ERROR_MESSAGE);
    if (options.onError) {
      options.onError(error, PNG_EXPORT_ERROR_MESSAGE);
    }
    throw error;
  }
}
