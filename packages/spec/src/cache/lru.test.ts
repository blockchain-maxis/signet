import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruSpecCache, DEFAULT_LRU_CAPACITY } from './lru.ts';
import type { SpecCache } from './types.ts';

test('LruSpecCache default capacity is 500', () => {
  const cache = new LruSpecCache();
  assert.equal(cache.maxCapacity, DEFAULT_LRU_CAPACITY);
  assert.equal(cache.maxCapacity, 500);
  assert.equal(cache.size, 0);
});

test('LruSpecCache validates capacity arguments', () => {
  assert.throws(() => new LruSpecCache(0), RangeError);
  assert.throws(() => new LruSpecCache(-10), RangeError);
  assert.throws(() => new LruSpecCache(1.5), RangeError);
  assert.doesNotThrow(() => new LruSpecCache(1));
});

test('LruSpecCache basic get, set, has, delete and clear operations', () => {
  const cache: SpecCache<string> = new LruSpecCache<string>(3);
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  cache.set(hashA, 'spec_a');
  cache.set(hashB, 'spec_b');

  assert.equal(cache.size, 2);
  assert.equal(cache.get(hashA), 'spec_a');
  assert.equal(cache.get(hashB), 'spec_b');
  assert.equal(cache.get('c'.repeat(64)), undefined);

  // Case-insensitivity normalization
  assert.equal(cache.get(hashA.toUpperCase()), 'spec_a');
  assert.equal(cache.has!(hashA.toUpperCase()), true);

  // Delete
  assert.equal((cache as LruSpecCache<string>).delete(hashA), true);
  assert.equal(cache.get(hashA), undefined);
  assert.equal(cache.size, 1);

  // Clear
  cache.clear!();
  assert.equal(cache.size, 0);
  assert.equal(cache.get(hashB), undefined);
});

test('LruSpecCache eviction order adheres strictly to least-recently-used', () => {
  const cache = new LruSpecCache<string>(3);
  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);
  const h3 = '3'.repeat(64);
  const h4 = '4'.repeat(64);

  cache.set(h1, 'one');
  cache.set(h2, 'two');
  cache.set(h3, 'three');
  assert.equal(cache.size, 3);

  // Adding h4 should evict h1 (the oldest unaccessed)
  cache.set(h4, 'four');
  assert.equal(cache.size, 3);
  assert.equal(cache.get(h1), undefined);
  assert.equal(cache.get(h2), 'two');
  assert.equal(cache.get(h3), 'three');
  assert.equal(cache.get(h4), 'four');
});

test('LruSpecCache recency refresh on get prevents eviction', () => {
  const cache = new LruSpecCache<string>(3);
  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);
  const h3 = '3'.repeat(64);
  const h4 = '4'.repeat(64);

  cache.set(h1, 'one');
  cache.set(h2, 'two');
  cache.set(h3, 'three');

  // Access h1 to make it most recently used (order now: h2, h3, h1)
  assert.equal(cache.get(h1), 'one');

  // Insert h4 -> should evict h2 (oldest), NOT h1
  cache.set(h4, 'four');
  assert.equal(cache.size, 3);
  assert.equal(cache.get(h2), undefined, 'h2 was least recently used and should have been evicted');
  assert.equal(cache.get(h1), 'one', 'h1 was refreshed on get and must not be evicted');
  assert.equal(cache.get(h3), 'three');
  assert.equal(cache.get(h4), 'four');
});

test('LruSpecCache recency refresh on overwrite/update', () => {
  const cache = new LruSpecCache<string>(2);
  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);
  const h3 = '3'.repeat(64);

  cache.set(h1, 'one');
  cache.set(h2, 'two');

  // Updating h1 promotes it (order now: h2, h1)
  cache.set(h1, 'one_updated');

  // Insert h3 -> should evict h2
  cache.set(h3, 'three');
  assert.equal(cache.get(h2), undefined);
  assert.equal(cache.get(h1), 'one_updated');
  assert.equal(cache.get(h3), 'three');
});

test('LruSpecCache capacity 1 behaves correctly', () => {
  const cache = new LruSpecCache<string>(1);
  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);

  cache.set(h1, 'one');
  assert.equal(cache.size, 1);
  assert.equal(cache.get(h1), 'one');

  cache.set(h2, 'two');
  assert.equal(cache.size, 1);
  assert.equal(cache.get(h1), undefined);
  assert.equal(cache.get(h2), 'two');
});

test('LruSpecCache never evicts on time (§4.1 immutability guarantee)', async () => {
  const cache = new LruSpecCache<string>(2);
  const h1 = '1'.repeat(64);
  cache.set(h1, 'immutable_spec');

  // Simulate time passage (no TTL exists)
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(cache.get(h1), 'immutable_spec', 'Entry should persist regardless of elapsed time');
});
