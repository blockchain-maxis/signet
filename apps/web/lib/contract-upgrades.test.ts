import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUpgrades, type WasmVersionRow } from './contract-upgrades.ts';

test('describeUpgrades: 0 rows returns empty description with null notes', () => {
  const result = describeUpgrades([]);
  assert.equal(result.hasUpgrades, false);
  assert.equal(result.upgradeCount, 0);
  assert.deepEqual(result.versions, []);
  assert.equal(result.headerNote, null);
  assert.equal(result.windowSentence, null);
  assert.equal(result.windowNote, null);
});

test('describeUpgrades: 1 row labels first seen by indexer, produces window sentence, null header note', () => {
  const row: WasmVersionRow = {
    wasmHash: '11'.repeat(32),
    observedAt: '2026-03-01T12:00:00Z',
    observedLedger: 100_000,
  };

  const result = describeUpgrades([row]);
  assert.equal(result.hasUpgrades, false);
  assert.equal(result.upgradeCount, 0);
  assert.equal(result.versions.length, 1);

  const version = result.versions[0]!;
  assert.equal(version.wasmHash, '11'.repeat(32));
  assert.equal(version.label, 'first seen by the indexer');
  assert.equal(version.observedLedger, 100_000);
  assert.equal(version.observedOn, '1 Mar 2026');

  assert.equal(result.headerNote, null);
  assert.equal(
    result.windowSentence,
    "Changes before 1 Mar 2026 are not recorded. Dates are when Signet's indexer noticed each hash, not when the upgrade transaction ran.",
  );
  assert.equal(result.windowNote, result.windowSentence);
});

test('describeUpgrades: several rows ordered newest first, correct labels and header note', () => {
  const rows: WasmVersionRow[] = [
    {
      wasmHash: '11'.repeat(32),
      observedAt: '2026-03-01T12:00:00Z',
      observedLedger: 100_000,
    },
    {
      wasmHash: '22'.repeat(32),
      observedAt: '2026-03-05T12:00:00Z',
      observedLedger: 105_000,
    },
    {
      wasmHash: '33'.repeat(32),
      observedAt: '2026-03-10T12:00:00Z',
      observedLedger: 110_000,
    },
  ];

  // Pass rows in scrambled order to verify deterministic sorting
  const result = describeUpgrades([rows[1]!, rows[2]!, rows[0]!]);

  assert.equal(result.hasUpgrades, true);
  assert.equal(result.upgradeCount, 2);
  assert.equal(result.versions.length, 3);

  // Newest first
  assert.equal(result.versions[0]!.wasmHash, '33'.repeat(32));
  assert.equal(result.versions[0]!.label, 'change observed by the indexer');
  assert.equal(result.versions[0]!.observedOn, '10 Mar 2026');

  assert.equal(result.versions[1]!.wasmHash, '22'.repeat(32));
  assert.equal(result.versions[1]!.label, 'change observed by the indexer');
  assert.equal(result.versions[1]!.observedOn, '5 Mar 2026');

  assert.equal(result.versions[2]!.wasmHash, '11'.repeat(32));
  assert.equal(result.versions[2]!.label, 'first seen by the indexer');
  assert.equal(result.versions[2]!.observedOn, '1 Mar 2026');

  // Header note and window sentence
  assert.equal(result.headerNote, 'upgraded 2 times since 1 Mar 2026');
  assert.equal(
    result.windowSentence,
    "Changes before 1 Mar 2026 are not recorded. Dates are when Signet's indexer noticed each hash, not when the upgrade transaction ran.",
  );
});

test('describeUpgrades: two versions notes upgraded 1 time since {date}', () => {
  const rows: WasmVersionRow[] = [
    {
      wasmHash: '11'.repeat(32),
      observedAt: '2026-03-01T12:00:00Z',
      observedLedger: 999_000,
    },
    {
      wasmHash: '22'.repeat(32),
      observedAt: '2026-03-05T12:00:00Z',
      observedLedger: 1_000_500,
    },
  ];

  const result = describeUpgrades(rows);
  assert.equal(result.hasUpgrades, true);
  assert.equal(result.upgradeCount, 1);
  assert.equal(result.headerNote, 'upgraded 1 time since 1 Mar 2026');
  assert.equal(result.versions[0]!.wasmHash, '22'.repeat(32));
  assert.equal(result.versions[0]!.label, 'change observed by the indexer');
  assert.equal(result.versions[1]!.wasmHash, '11'.repeat(32));
  assert.equal(result.versions[1]!.label, 'first seen by the indexer');
});

test('describeUpgrades: rollback to earlier hash (no new DB row added by #416) retains existing history', () => {
  // #416 upserts by unique (contractId, wasmHash), so rolling back from hash 2 to hash 1
  // does not create a third row in the table. The existing 2 rows are processed reliably.
  const rows: WasmVersionRow[] = [
    {
      wasmHash: '11'.repeat(32),
      observedAt: new Date('2026-03-01T12:00:00Z'),
      observedLedger: 100_000,
    },
    {
      wasmHash: '22'.repeat(32),
      observedAt: new Date('2026-03-05T12:00:00Z'),
      observedLedger: 105_000,
    },
  ];

  const result = describeUpgrades(rows);
  assert.equal(result.hasUpgrades, true);
  assert.equal(result.upgradeCount, 1);
  assert.equal(result.headerNote, 'upgraded 1 time since 1 Mar 2026');
  assert.equal(result.versions.length, 2);
  assert.equal(result.versions[0]!.wasmHash, '22'.repeat(32));
  assert.equal(result.versions[1]!.wasmHash, '11'.repeat(32));
  assert.equal(
    result.windowSentence,
    "Changes before 1 Mar 2026 are not recorded. Dates are when Signet's indexer noticed each hash, not when the upgrade transaction ran.",
  );
});
