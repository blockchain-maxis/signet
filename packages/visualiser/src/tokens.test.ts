import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIZ_CSS_VARIABLES,
  VIZ_DARK_TOKENS,
  VIZ_LIGHT_TOKENS,
  VIZ_TOKEN_NAMES,
  VIZ_TOKENS,
  generateInlineTokensStyle,
  generateTokensCss,
  type VizTokenName,
} from './tokens.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tokensCssPath = path.resolve(__dirname, 'tokens.css');

/**
 * Parses custom property declarations from a CSS block.
 */
function parseCssDeclarations(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = regex.exec(block)) !== null) {
    result[`--${match[1]}`] = match[2].trim();
  }
  return result;
}

test('tokens.css exists and exactly matches generateTokensCss()', () => {
  const fileContent = fs.readFileSync(tokensCssPath, 'utf8').replace(/\r\n/g, '\n');
  const generated = generateTokensCss().replace(/\r\n/g, '\n');
  assert.equal(fileContent, generated);
});

test('VIZ_TOKEN_NAMES contains all 10 required tokens', () => {
  const expectedNames: VizTokenName[] = [
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
  ];
  assert.deepEqual([...VIZ_TOKEN_NAMES].sort(), [...expectedNames].sort());
  assert.equal(expectedNames.length, 10);
});

test('VIZ_CSS_VARIABLES maps every token to its --viz-* CSS variable', () => {
  const expectedVars: Record<VizTokenName, string> = {
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
  };

  for (const name of VIZ_TOKEN_NAMES) {
    assert.equal(VIZ_CSS_VARIABLES[name], expectedVars[name]);
  }
});

test('CSS file declares identical token values for dark mode (:root and [data-viz-theme="dark"])', () => {
  const fileContent = fs.readFileSync(tokensCssPath, 'utf8');

  // Extract :root block
  const rootMatch = fileContent.match(/:root\s*\{([^}]+)\}/);
  assert.ok(rootMatch, ':root block must exist in tokens.css');
  const rootDecls = parseCssDeclarations(rootMatch[1]);

  // Extract [data-viz-theme="dark"] or [data-viz-theme='dark'] block
  const darkMatch = fileContent.match(/\[data-viz-theme=['"]dark['"]\]\s*\{([^}]+)\}/);
  assert.ok(darkMatch, '[data-viz-theme="dark"] block must exist in tokens.css');
  const darkDecls = parseCssDeclarations(darkMatch[1]);

  for (const name of VIZ_TOKEN_NAMES) {
    const varName = VIZ_CSS_VARIABLES[name];
    const expectedValue = VIZ_DARK_TOKENS[name];

    assert.equal(rootDecls[varName], expectedValue, `:root ${varName} matches VIZ_DARK_TOKENS`);
    assert.equal(darkDecls[varName], expectedValue, `[data-viz-theme="dark"] ${varName} matches VIZ_DARK_TOKENS`);
  }
});

test('CSS file declares identical token values for light mode (@media and [data-viz-theme="light"])', () => {
  const fileContent = fs.readFileSync(tokensCssPath, 'utf8');

  // Extract @media (prefers-color-scheme: light) block
  const mediaMatch = fileContent.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]+)\}/);
  assert.ok(mediaMatch, '@media (prefers-color-scheme: light) block must exist in tokens.css');
  const mediaDecls = parseCssDeclarations(mediaMatch[1]);

  // Extract [data-viz-theme="light"] or [data-viz-theme='light'] block
  const lightMatch = fileContent.match(/\[data-viz-theme=['"]light['"]\]\s*\{([^}]+)\}/);
  assert.ok(lightMatch, '[data-viz-theme="light"] block must exist in tokens.css');
  const lightDecls = parseCssDeclarations(lightMatch[1]);

  for (const name of VIZ_TOKEN_NAMES) {
    const varName = VIZ_CSS_VARIABLES[name];
    const expectedValue = VIZ_LIGHT_TOKENS[name];

    assert.equal(mediaDecls[varName], expectedValue, `@media ${varName} matches VIZ_LIGHT_TOKENS`);
    assert.equal(lightDecls[varName], expectedValue, `[data-viz-theme="light"] ${varName} matches VIZ_LIGHT_TOKENS`);
  }
});

test('all tokens are valid 3, 6, or 8-digit hex colors', () => {
  const hexRegex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

  for (const theme of ['dark', 'light'] as const) {
    const tokens = VIZ_TOKENS[theme];
    for (const name of VIZ_TOKEN_NAMES) {
      assert.match(
        tokens[name],
        hexRegex,
        `Token ${name} in ${theme} theme must be a valid hex color: ${tokens[name]}`,
      );
    }
  }
});

test('generateInlineTokensStyle produces standalone CSS with valid declarations', () => {
  const darkStyle = generateInlineTokensStyle('dark');
  assert.ok(darkStyle.includes('--viz-ground: #0a0908'));
  assert.ok(darkStyle.includes('--viz-node-text: #f5f4ee'));

  const lightStyle = generateInlineTokensStyle('light');
  assert.ok(lightStyle.includes('--viz-ground: #ffffff'));
  assert.ok(lightStyle.includes('--viz-node-text: #0a0908'));

  const fullStyle = generateInlineTokensStyle();
  assert.ok(fullStyle.includes('@media (prefers-color-scheme: light)'));
});

test('no hardcoded hex colors exist in render*.ts files', () => {
  const srcFiles = fs.readdirSync(__dirname);
  const renderFiles = srcFiles.filter((f) => /^render.*\.ts$/.test(f));

  const hexPattern = /#[0-9a-fA-F]{3,8}/;
  for (const file of renderFiles) {
    const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const match = content.match(hexPattern);
    assert.equal(
      match,
      null,
      `File ${file} must not contain hardcoded hex colors, found: ${match?.[0]}`,
    );
  }
});

/**
 * Calculates WCAG relative luminance of an sRGB hex color.
 */
function relativeLuminance(hex: string): number {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = parseInt(cleaned.slice(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const brighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (brighter + 0.05) / (darker + 0.05);
}

test('WCAG AA contrast: nodeText against ground is >= 4.5:1 on both dark and light grounds', () => {
  const darkRatio = contrastRatio(VIZ_DARK_TOKENS.nodeText, VIZ_DARK_TOKENS.ground);
  assert.ok(darkRatio >= 4.5, `Dark nodeText contrast ratio was ${darkRatio.toFixed(2)}, expected >= 4.5`);

  const lightRatio = contrastRatio(VIZ_LIGHT_TOKENS.nodeText, VIZ_LIGHT_TOKENS.ground);
  assert.ok(lightRatio >= 4.5, `Light nodeText contrast ratio was ${lightRatio.toFixed(2)}, expected >= 4.5`);
});

test('WCAG AA contrast: edge against ground is >= 3.0:1 on both dark and light grounds', () => {
  const darkEdgeRatio = contrastRatio(VIZ_DARK_TOKENS.edge, VIZ_DARK_TOKENS.ground);
  assert.ok(darkEdgeRatio >= 3.0, `Dark edge contrast ratio was ${darkEdgeRatio.toFixed(2)}, expected >= 3.0`);

  const lightEdgeRatio = contrastRatio(VIZ_LIGHT_TOKENS.edge, VIZ_LIGHT_TOKENS.ground);
  assert.ok(lightEdgeRatio >= 3.0, `Light edge contrast ratio was ${lightEdgeRatio.toFixed(2)}, expected >= 3.0`);
});
