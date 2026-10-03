/**
 * @file @signet/visualiser theme tokens
 *
 * Theme token definitions for the contract diagram in dark and light modes.
 * Independent of the site palette to allow standalone exports, SVG inlining,
 * embeds, and print.
 */

export interface VizThemeTokens {
  /** Canvas / diagram background ground. */
  ground: string;
  /** Node background fill. */
  node: string;
  /** Primary node text colour. */
  nodeText: string;
  /** Edge stroke colour. */
  edge: string;
  /** Muted secondary text, auxiliary labels. */
  muted: string;
  /** Highlight / selected accent colour. */
  accent: string;
  /** Mutating / state-write function indicator. */
  write: string;
  /** Read-only function indicator. */
  read: string;
  /** Observed / indexed activity indicator. */
  observed: string;
  /** Focus indicator outline / ring. */
  focus: string;
}

export type VizTheme = 'dark' | 'light';

export const VIZ_TOKEN_NAMES = [
  'ground',
  'node',
  'nodeText',
  'edge',
  'muted',
  'accent',
  'write',
  'read',
  'observed',
  'focus',
] as const;

export type VizTokenName = (typeof VIZ_TOKEN_NAMES)[number];

export const VIZ_CSS_VARIABLES: Record<VizTokenName, string> = {
  ground: '--viz-ground',
  node: '--viz-node',
  nodeText: '--viz-node-text',
  edge: '--viz-edge',
  muted: '--viz-muted',
  accent: '--viz-accent',
  write: '--viz-write',
  read: '--viz-read',
  observed: '--viz-observed',
  focus: '--viz-focus',
} as const;

export const VIZ_DARK_TOKENS: VizThemeTokens = {
  ground: '#0a0908',
  node: '#181614',
  nodeText: '#f5f4ee',
  edge: '#736e62',
  muted: '#9e9a8f',
  accent: '#e05252',
  write: '#fb923c',
  read: '#38bdf8',
  observed: '#c084fc',
  focus: '#60a5fa',
};

export const VIZ_LIGHT_TOKENS: VizThemeTokens = {
  ground: '#ffffff',
  node: '#f5f4ee',
  nodeText: '#0a0908',
  edge: '#736e62',
  muted: '#5e5b51',
  accent: '#8b1a1a',
  write: '#c2410c',
  read: '#0369a1',
  observed: '#6d28d9',
  focus: '#1d4ed8',
};

export const VIZ_TOKENS: Record<VizTheme, VizThemeTokens> = {
  dark: VIZ_DARK_TOKENS,
  light: VIZ_LIGHT_TOKENS,
};

/**
 * Formats a theme's tokens as CSS custom property declaration lines.
 */
export function formatTokenDeclarations(tokens: VizThemeTokens, indent = '  '): string {
  return [
    `${indent}--viz-ground: ${tokens.ground};`,
    `${indent}--viz-node: ${tokens.node};`,
    `${indent}--viz-node-text: ${tokens.nodeText};`,
    `${indent}--viz-edge: ${tokens.edge};`,
    `${indent}--viz-muted: ${tokens.muted};`,
    `${indent}--viz-accent: ${tokens.accent};`,
    `${indent}--viz-write: ${tokens.write};`,
    `${indent}--viz-read: ${tokens.read};`,
    `${indent}--viz-observed: ${tokens.observed};`,
    `${indent}--viz-focus: ${tokens.focus};`,
  ].join('\n');
}

/**
 * Generates the full contents of `tokens.css`.
 */
export function generateTokensCss(): string {
  return [
    '/* @signet/visualiser design tokens. */',
    ':root {',
    formatTokenDeclarations(VIZ_DARK_TOKENS),
    '}',
    '',
    '@media (prefers-color-scheme: light) {',
    '  :root {',
    formatTokenDeclarations(VIZ_LIGHT_TOKENS, '    '),
    '  }',
    '}',
    '',
    "[data-viz-theme='light'] {",
    formatTokenDeclarations(VIZ_LIGHT_TOKENS),
    '}',
    '',
    "[data-viz-theme='dark'] {",
    formatTokenDeclarations(VIZ_DARK_TOKENS),
    '}',
    '',
  ].join('\n');
}

/**
 * Generates an inline `<style>` block string for standalone diagram SVG exports.
 */
export function generateInlineTokensStyle(theme?: VizTheme): string {
  if (theme) {
    return `:root, svg {\n${formatTokenDeclarations(VIZ_TOKENS[theme])}\n}`;
  }
  return generateTokensCss();
}
