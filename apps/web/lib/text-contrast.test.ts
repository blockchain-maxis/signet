import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

function luminance(hex: string): number {
  const channels = hex.match(/[\da-f]{2}/gi)!.map((part) => {
    const c = parseInt(part, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

test('shared small-text colours meet WCAG AA on the page and raised surfaces', () => {
  for (const token of ['--text-muted', '--text-faint', '--text-accent']) {
    const value = css.match(new RegExp(`${token}:\\s*(#[\\da-f]{6})`, 'i'))?.[1];
    assert.ok(value, `${token} must be a concrete six-digit palette value`);
    for (const background of ['#0a0908', '#0e0d0b', '#141310', '#1f1d19', '#1a0d0a', '#1a0808']) {
      const ratio = (luminance(value) + 0.05) / (luminance(background) + 0.05);
      assert.ok(ratio >= 4.5, `${token} on ${background} is ${ratio.toFixed(2)}:1`);
    }
  }
});
