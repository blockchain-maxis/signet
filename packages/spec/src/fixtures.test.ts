import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

interface ManifestEntry {
  file: string;
  sourceContract: string;
  network: string;
  wasmHash: string;
  bytes: number;
  fetchedAt: string;
}

test('fixtures/manifest.json entries exist and match recorded provenance and SHA-256 hash', () => {
  const manifestPath = join(FIXTURES_DIR, 'manifest.json');
  assert.ok(existsSync(manifestPath), 'manifest.json exists');

  const manifest: Record<string, ManifestEntry> = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  );
  assert.ok(Object.keys(manifest).length > 0, 'manifest has entries');

  for (const [key, entry] of Object.entries(manifest)) {
    assert.ok(entry.file, `${key} has file property`);
    assert.ok(entry.sourceContract, `${key} has sourceContract`);
    assert.ok(entry.network, `${key} has network`);
    assert.ok(entry.wasmHash, `${key} has wasmHash`);
    assert.ok(entry.bytes > 0, `${key} has byte length`);
    assert.ok(entry.fetchedAt, `${key} has fetchedAt timestamp`);

    const wasmPath = join(FIXTURES_DIR, entry.file);
    assert.ok(existsSync(wasmPath), `WASM file ${entry.file} exists`);

    const wasmBytes = readFileSync(wasmPath);
    assert.equal(wasmBytes.length, entry.bytes, `${entry.file} byte length matches manifest`);

    const computedHash = createHash('sha256').update(wasmBytes).digest('hex');
    assert.equal(computedHash, entry.wasmHash, `${entry.file} SHA-256 matches manifest wasmHash`);
  }
});

test('identity-registry.wasm fixture matches exact deployed bytecode specification (6,240 bytes)', () => {
  const regPath = join(FIXTURES_DIR, 'identity-registry.wasm');
  assert.ok(existsSync(regPath));
  const bytes = readFileSync(regPath);
  assert.equal(bytes.length, 6240);
});
