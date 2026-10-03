import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIZ_DARK_TOKENS,
  VIZ_LIGHT_TOKENS,
  type VizTheme,
  type VizThemeTokens,
  type VizTokenName,
} from './tokens.ts';

/**
 * Calculates WCAG 2.1 relative luminance of an sRGB hex color.
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 */
export function relativeLuminance(hex: string): number {
  let cleaned = hex.replace('#', '').trim();
  if (cleaned.length === 3) {
    cleaned = cleaned
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = parseInt(cleaned.slice(4, 6), 16) / 255;

  const toLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Computes the contrast ratio between two hex colors (1:1 to 21:1).
 * Ratio = (L1 + 0.05) / (L2 + 0.05) where L1 is lighter and L2 is darker.
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const brighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (brighter + 0.05) / (darker + 0.05);
}

/** Token classification according to WCAG AA requirements in Design §2.3. */
export type TokenKind = 'text' | 'stroke';

export interface TokenRequirement {
  name: VizTokenName;
  kind: TokenKind;
  minRatio: number;
  /** Primary ground(s) against which this token must maintain contrast. */
  grounds: Array<'ground' | 'node'>;
}

/**
 * WCAG AA requirements per Design §2.3:
 * - Text tokens: >= 4.5:1
 * - Non-text / stroke tokens: >= 3.0:1
 */
export const TOKEN_REQUIREMENTS: TokenRequirement[] = [
  {
    name: 'nodeText',
    kind: 'text',
    minRatio: 4.5,
    grounds: ['node', 'ground'],
  },
  {
    name: 'muted',
    kind: 'text',
    minRatio: 4.5,
    grounds: ['ground', 'node'],
  },
  {
    name: 'accent',
    kind: 'text',
    minRatio: 4.5,
    grounds: ['ground', 'node'],
  },
  {
    name: 'write',
    kind: 'text',
    minRatio: 4.5,
    grounds: ['ground', 'node'],
  },
  {
    name: 'read',
    kind: 'text',
    minRatio: 4.5,
    grounds: ['ground', 'node'],
  },
  {
    name: 'observed',
    kind: 'text',
    minRatio: 4.5,
    grounds: ['ground', 'node'],
  },
  {
    name: 'edge',
    kind: 'stroke',
    minRatio: 3.0,
    grounds: ['ground', 'node'],
  },
  {
    name: 'focus',
    kind: 'stroke',
    minRatio: 3.0,
    grounds: ['ground', 'node'],
  },
];

interface ContrastCheckResult {
  theme: VizTheme;
  tokenName: VizTokenName;
  groundName: 'ground' | 'node';
  tokenColor: string;
  groundColor: string;
  kind: TokenKind;
  minRatio: number;
  actualRatio: number;
  passed: boolean;
}

/**
 * Runs contrast check on all defined token requirements for a given theme.
 */
export function checkThemeContrast(
  theme: VizTheme,
  tokens: VizThemeTokens,
): ContrastCheckResult[] {
  const results: ContrastCheckResult[] = [];

  for (const req of TOKEN_REQUIREMENTS) {
    const tokenColor = tokens[req.name];
    for (const groundName of req.grounds) {
      const groundColor = tokens[groundName];
      const actualRatio = contrastRatio(tokenColor, groundColor);
      results.push({
        theme,
        tokenName: req.name,
        groundName,
        tokenColor,
        groundColor,
        kind: req.kind,
        minRatio: req.minRatio,
        actualRatio,
        passed: actualRatio >= req.minRatio,
      });
    }
  }

  return results;
}

test('WCAG AA contrast: all dark theme tokens meet contrast requirements on ground and node', () => {
  const results = checkThemeContrast('dark', VIZ_DARK_TOKENS);
  const failures = results.filter((r) => !r.passed);

  if (failures.length > 0) {
    const failureMessages = failures.map(
      (f) =>
        `[DARK FAIL] ${f.kind} token "${f.tokenName}" (${f.tokenColor}) on "${f.groundName}" (${f.groundColor}) ` +
        `has ratio ${f.actualRatio.toFixed(2)}:1, requires >= ${f.minRatio.toFixed(1)}:1`,
    );
    assert.fail(`Dark theme contrast failures:\n${failureMessages.join('\n')}`);
  }

  assert.equal(failures.length, 0);
});

test('WCAG AA contrast: all light theme tokens meet contrast requirements on ground and node', () => {
  const results = checkThemeContrast('light', VIZ_LIGHT_TOKENS);
  const failures = results.filter((r) => !r.passed);

  if (failures.length > 0) {
    const failureMessages = failures.map(
      (f) =>
        `[LIGHT FAIL] ${f.kind} token "${f.tokenName}" (${f.tokenColor}) on "${f.groundName}" (${f.groundColor}) ` +
        `has ratio ${f.actualRatio.toFixed(2)}:1, requires >= ${f.minRatio.toFixed(1)}:1`,
    );
    assert.fail(`Light theme contrast failures:\n${failureMessages.join('\n')}`);
  }

  assert.equal(failures.length, 0);
});

test('relativeLuminance computes known reference values accurately', () => {
  assert.equal(relativeLuminance('#ffffff'), 1.0);
  assert.equal(relativeLuminance('#000000'), 0.0);
  // 3-digit expansion
  assert.equal(relativeLuminance('#fff'), 1.0);
  assert.equal(relativeLuminance('#000'), 0.0);
});

test('contrastRatio computes known pairs correctly', () => {
  const blackWhite = contrastRatio('#ffffff', '#000000');
  assert.equal(Math.round(blackWhite * 10) / 10, 21.0);

  const sameColor = contrastRatio('#123456', '#123456');
  assert.equal(sameColor, 1.0);
});

test('contrast check prints pair name, colors, and ratio on synthetic failure', () => {
  const syntheticTokens: VizThemeTokens = {
    ...VIZ_DARK_TOKENS,
    nodeText: '#101010', // Extremely low contrast against dark ground #0a0908
  };

  const results = checkThemeContrast('dark', syntheticTokens);
  const failing = results.filter((r) => !r.passed && r.tokenName === 'nodeText');
  assert.ok(failing.length > 0);

  const failure = failing[0];
  assert.ok(failure);
  assert.equal(failure.tokenName, 'nodeText');
  assert.equal(failure.tokenColor, '#101010');
  assert.ok(failure.actualRatio < 4.5);
});
