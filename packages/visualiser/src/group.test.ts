import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFunctions, type FunctionGroup } from './group.ts';

/** Collapses groups to `name: members` pairs for compact assertions. */
function shape(groups: readonly FunctionGroup[]): Array<[string, readonly string[]]> {
  return groups.map((g) => [g.name, g.functions]);
}

test('no underscores: nothing to cluster, left ungrouped', () => {
  assert.deepEqual(groupFunctions(['swap', 'burn', 'mint', 'claim']), []);
});

test('empty input is left ungrouped', () => {
  assert.deepEqual(groupFunctions([]), []);
});

test('a prefix with exactly 2 members is not grouped', () => {
  const groups = groupFunctions([
    'pool_add',
    'pool_remove',
    'admin_set',
    'admin_get',
    'admin_pause',
    'admin_resume',
  ]);
  assert.deepEqual(shape(groups), [
    ['admin', ['admin_set', 'admin_get', 'admin_pause', 'admin_resume']],
    ['other', ['pool_add', 'pool_remove']],
  ]);
});

test('a prefix with exactly 3 members forms a group', () => {
  const groups = groupFunctions(['pool_a', 'pool_b', 'pool_c', 'swap']);
  assert.deepEqual(shape(groups), [
    ['pool', ['pool_a', 'pool_b', 'pool_c']],
    ['other', ['swap']],
  ]);
});

test('a single group is left ungrouped', () => {
  assert.deepEqual(groupFunctions(['pool_a', 'pool_b', 'pool_c', 'pool_d']), []);
});

test('__constructor goes to the lifecycle group', () => {
  const groups = groupFunctions(['__constructor', 'pool_a', 'pool_b', 'pool_c']);
  assert.deepEqual(shape(groups), [
    ['pool', ['pool_a', 'pool_b', 'pool_c']],
    ['lifecycle', ['__constructor']],
  ]);
  assert.equal(groups[1]?.kind, 'lifecycle');
});

test('well-known entrypoints go to lifecycle whatever their prefix', () => {
  const groups = groupFunctions([
    'init',
    'initialize',
    'upgrade',
    'version',
    '__constructor',
    'pool_a',
    'pool_b',
    'pool_c',
  ]);
  assert.deepEqual(shape(groups), [
    ['lifecycle', ['init', 'initialize', 'upgrade', 'version', '__constructor']],
    ['pool', ['pool_a', 'pool_b', 'pool_c']],
  ]);
});

test('lifecycle names are not counted toward a prefix group', () => {
  const groups = groupFunctions(['init', 'init_a', 'init_b', 'swap']);
  assert.deepEqual(shape(groups), [
    ['other', ['init_a', 'init_b', 'swap']],
    ['lifecycle', ['init']],
  ]);
});

test('splits on the first underscore only', () => {
  const groups = groupFunctions(['pool_add_liquidity', 'pool_remove_liquidity', 'pool_swap', 'x']);
  assert.deepEqual(shape(groups), [
    ['pool', ['pool_add_liquidity', 'pool_remove_liquidity', 'pool_swap']],
    ['other', ['x']],
  ]);
});

test('a leading underscore gives no prefix', () => {
  const groups = groupFunctions(['_a', '_b', '_c', 'pool_a', 'pool_b', 'pool_c']);
  assert.deepEqual(shape(groups), [
    ['other', ['_a', '_b', '_c']],
    ['pool', ['pool_a', 'pool_b', 'pool_c']],
  ]);
});

test('groups sort by size descending, then alphabetically', () => {
  const groups = groupFunctions([
    'zed_a',
    'zed_b',
    'zed_c',
    'amp_a',
    'amp_b',
    'amp_c',
    'big_a',
    'big_b',
    'big_c',
    'big_d',
    'solo',
  ]);
  assert.deepEqual(
    groups.map((g) => g.name),
    ['big', 'amp', 'zed', 'other'],
  );
});

test('other is just another group in the size order', () => {
  const groups = groupFunctions(['a', 'b', 'c', 'd', 'pool_a', 'pool_b', 'pool_c']);
  assert.deepEqual(
    groups.map((g) => g.name),
    ['other', 'pool'],
  );
});

test('an other_* prefix is not mistaken for the catch-all', () => {
  const groups = groupFunctions(['other_a', 'other_b', 'other_c', 'swap']);
  assert.deepEqual(
    groups.map((g) => [g.name, g.kind]),
    [
      ['other', 'prefix'],
      ['other', 'other'],
    ],
  );
});

test('functions within a group keep input order', () => {
  const groups = groupFunctions(['pool_z', 'pool_a', 'pool_m', 'swap', 'burn']);
  assert.deepEqual(groups[0]?.functions, ['pool_z', 'pool_a', 'pool_m']);
  assert.deepEqual(groups[1]?.functions, ['swap', 'burn']);
});

test('group order is stable when the input order is shuffled', () => {
  const names = [
    '__constructor',
    'pool_add',
    'pool_remove',
    'pool_swap',
    'pool_skim',
    'admin_set',
    'admin_get',
    'admin_pause',
    'get_a',
    'get_b',
    'get_c',
    'version',
    'swap',
    'burn',
    'x_one',
    'x_two',
  ];
  const baseline = groupFunctions(names);
  const expected = baseline.map((g) => g.name);
  // other (4) and pool (4) tie on size, so name order decides.
  assert.deepEqual(expected, ['other', 'pool', 'admin', 'get', 'lifecycle']);

  // Deterministic reorderings: reversed, rotated, and a seeded shuffle.
  let seed = 1;
  const shuffled = [...names].sort(() => {
    seed = (seed * 48271) % 2147483647;
    return (seed % 3) - 1;
  });
  const orders = [[...names].reverse(), [...names.slice(5), ...names.slice(0, 5)], shuffled];
  for (const order of orders) {
    const groups = groupFunctions(order);
    assert.deepEqual(
      groups.map((g) => g.name),
      expected,
    );
    // Same membership, even though in-group order follows the input.
    assert.deepEqual(
      groups.map((g) => [...g.functions].sort()),
      baseline.map((g) => [...g.functions].sort()),
    );
  }
});

test('does not mutate its input', () => {
  const names = ['pool_a', 'pool_b', 'pool_c', 'swap'];
  const copy = [...names];
  groupFunctions(names);
  assert.deepEqual(names, copy);
});
