import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkArgs, run } from './cli.ts';

test('parseLinkArgs treats --help / -h as help mode', () => {
  const none = parseLinkArgs([]);
  assert.equal(none.ok, true);
  if (none.ok) assert.deepEqual(none.args, { help: false });
  assert.deepEqual(parseLinkArgs(['--help']), { ok: true, args: { help: true } });
  assert.deepEqual(parseLinkArgs(['-h']), { ok: true, args: { help: true } });
});

test('parseLinkArgs reads --api in both forms', () => {
  assert.deepEqual(parseLinkArgs(['--api', 'http://x:3000']), { ok: true, args: { help: false, api: 'http://x:3000' } });
  assert.deepEqual(parseLinkArgs(['--api=http://x:3000/']), { ok: true, args: { help: false, api: 'http://x:3000/' } });
});

test('parseLinkArgs rejects unknown args and a missing --api value', () => {
  assert.deepEqual(parseLinkArgs(['--bogus']), { ok: false, message: "signet link: unknown argument '--bogus'" });
  assert.equal(parseLinkArgs(['--api']).ok, false);
});

test('run prints help and exits 0 with no arguments', async () => {
  assert.equal(await run([]), 0);
});

test('run --version exits 0 and names the CLI', async () => {
  assert.equal(await run(['--version']), 0);
});

test('run link --help exits 0 without touching the network', async () => {
  assert.equal(await run(['link', '--help']), 0);
});

test('run with an unknown command exits 1', async () => {
  assert.equal(await run(['frobnicate']), 1);
});