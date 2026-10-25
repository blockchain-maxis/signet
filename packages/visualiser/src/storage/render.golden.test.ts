/**
 * @file Golden SVG of the storage layout view (#515).
 *
 * The Identity Registry with its committed testnet observations
 * (`fixtures/observations/identity-registry.json`: a real `claim`
 * transaction and a `count()` simulation), grouped into slots by #513's
 * `groupLedgerKeys`, plus the instance entry as #514 reads it.
 *
 * `UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test` rewrites it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import { groupLedgerKeys, normaliseFootprint, type RawFootprint } from '@signet/spec';
import { FIXTURES_DIR, loadFixture } from '../load-fixture.ts';
import {
  renderStorageOutlineHtml,
  renderStorageSvg,
  slotId,
  storageHeading,
  type StorageViewInput,
} from './render.ts';

const GOLDEN = join(FIXTURES_DIR, '__golden__', 'storage', 'identity-registry.svg');
const ADMIN = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function view(): StorageViewInput {
  const committed = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'observations', 'identity-registry.json'), 'utf8'),
  ) as { contract: string; footprints: RawFootprint[] };
  const observations = committed.footprints.map(normaliseFootprint);
  const slots = groupLedgerKeys(observations, committed.contract, loadFixture('identity-registry'));
  const ledgers = observations.map((o) => o.ledger);
  return {
    slots,
    observations: observations.length,
    firstLedger: Math.min(...ledgers),
    lastLedger: Math.max(...ledgers),
    instance: {
      ledger: 5_258_000,
      entries: [
        { key: '[Admin]', shape: 'Admin', specType: 'DataKey', valueType: 'Address', valuePreview: ADMIN },
        { key: '[Count]', shape: 'Count', specType: 'DataKey', valueType: 'U32', valuePreview: '12' },
      ],
    },
  };
}

function render(focus?: string): string {
  return `${renderStorageSvg(view(), {
    idPrefix: 'storage-',
    title: 'identity-registry storage, observed',
    hrefForType: (name) => `#type-${name}`,
    hrefForFunction: (name) => `#fn-${name}`,
    ...(focus && { focus }),
  })}\n`;
}

test('golden: the registry storage seen in its committed observations', () => {
  const svg = render();
  if (env.UPDATE_GOLDEN === '1') {
    mkdirSync(join(FIXTURES_DIR, '__golden__', 'storage'), { recursive: true });
    if (!existsSync(GOLDEN) || readFileSync(GOLDEN, 'utf8') !== svg) writeFileSync(GOLDEN, svg);
  }
  assert.ok(existsSync(GOLDEN), 'no golden; run with UPDATE_GOLDEN=1');
  assert.equal(svg, readFileSync(GOLDEN, 'utf8'), 'the storage view differs from its golden');
});

test('the registry slots: claim writes Owner and Handle, count reads the instance', () => {
  const input = view();
  const ids = input.slots.map(slotId);
  assert.ok(ids.includes('slot:persistent:Owner(String)'), ids.join(' '));
  assert.ok(ids.includes('slot:persistent:Handle(Address)'), ids.join(' '));
  assert.ok(ids.includes('slot:instance:Instance'), ids.join(' '));
  const svg = render();
  assert.match(svg, /data-edge-kind="observed-write" data-from="fn:claim" data-to="slot:persistent:Owner\(String\)"/);
  assert.match(svg, /data-edge-kind="observed" data-from="fn:count" data-to="slot:instance:Instance"/);
  // The registry's DataKey is private, so no key matched a spec type.
  assert.doesNotMatch(svg, /storage-type-link/);
});

test("a slot whose key matched a spec type links to the type's page", () => {
  const input = view();
  const slots = input.slots.map((s) => (s.shape === 'Owner(String)' ? { ...s, specType: 'DataKey' } : s));
  const svg = renderStorageSvg({ ...input, slots }, { idPrefix: 's-', title: 't', hrefForType: (name) => `#type-${name}` });
  assert.match(svg, /<a href="#type-DataKey" class="storage-type-link">/);
  const html = renderStorageOutlineHtml({ ...input, slots }, (name) => `#type-${name}`);
  assert.match(html, /<code>Owner\(String\)<\/code>: 1 distinct key seen at ledger 5257992; written by claim\. Key type: <a href="#type-DataKey">DataKey<\/a>\./);
});

test('the heading says the slots are observed, not a schema', () => {
  const heading = storageHeading(view());
  assert.equal(
    heading,
    "Storage seen in 2 observed calls (ledgers 5257992–5257995) and the instance entry at ledger 5258000. Soroban contracts don't declare a storage schema, so keys this contract never touched in those calls aren't shown.",
  );
  assert.ok(render().includes('aren&apos;t shown'));
  // Every edge is dashed: observed, never spec structure.
  for (const edge of render().match(/<path class="diagram-edge[^>]*>/g) ?? []) {
    assert.match(edge, /stroke-dasharray="5 3"/);
  }
});

test('a slot permalink focuses it and its functions, and dims the rest', () => {
  const svg = render('slot:persistent:Owner(String)');
  assert.match(svg, /data-node-id="slot:persistent:Owner\(String\)"[^>]*class="storage-node storage-slot viz-focused"/);
  assert.match(svg, /data-node-id="fn:claim" class="storage-node viz-neighbour"/);
  assert.match(svg, /data-node-id="fn:count" class="storage-node viz-dimmed"/);
  // An unknown focus id changes nothing.
  assert.equal(render('slot:persistent:<script>'), render());
});

test('the outline lists every slot, who touched it, and the instance keys', () => {
  const html = renderStorageOutlineHtml(view(), (name) => `#type-${name}`);
  assert.match(html, /<code>Owner\(String\)<\/code>: 1 distinct key seen at ledger 5257992; written by claim\./);
  assert.match(html, /<code>Instance<\/code>: 1 distinct key seen between ledgers 5257992 and 5257995; written by claim; read by count\./);
  assert.match(html, /Instance entry at ledger 5258000/);
  assert.match(html, /<code>Count<\/code> = 12 \(U32\)/);
});

test('an unreadable instance entry is stated, and the view still draws', () => {
  const input = { ...view(), instance: { ledger: 5_258_000, reason: 'instance entry archived; restore needed to read' } };
  const svg = renderStorageSvg(input, { idPrefix: 's-', title: 't' });
  assert.match(svg, /instance entry archived; restore needed to read/);
  assert.doesNotMatch(storageHeading(input), /instance entry at ledger/);
});

test('a standalone export inlines the theme tokens and paints the ground', () => {
  const svg = renderStorageSvg(view(), { idPrefix: 's-', title: 't', theme: 'dark' });
  assert.match(svg, /<style>:root, svg \{/);
  assert.match(svg, /class="storage-ground"/);
});
