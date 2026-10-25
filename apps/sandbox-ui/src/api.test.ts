import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashWithoutToken, splitLines, tokenFromHash } from './api.ts';

const TOKEN = 'kq3Zp0X8wQ1m5Ytv7Hc2LnR4sJd9BfE6uA-bC_xYz12';

test('the token comes from the fragment and nowhere else', () => {
  assert.equal(tokenFromHash(`#t=${TOKEN}`), TOKEN);
  assert.equal(tokenFromHash(`#t=${TOKEN}&view=diagram`), TOKEN);
  assert.equal(tokenFromHash('#view=diagram'), null);
  assert.equal(tokenFromHash('#t=short'), null);
  assert.equal(tokenFromHash('#t=<script>alert(1)</script>'), null);
});

test('the token is taken out of the address bar, the rest kept', () => {
  assert.equal(hashWithoutToken(`#t=${TOKEN}`), '');
  assert.equal(hashWithoutToken(`#t=${TOKEN}&view=diagram`), '#view=diagram');
});

test('streamed NDJSON is split into whole lines', () => {
  const first = splitLines('{"type":"build.started"}\n{"type":"cycle.comp');
  assert.deepEqual(first.lines, [{ type: 'build.started' }]);
  assert.equal(first.rest, '{"type":"cycle.comp');
  const second = splitLines(`${first.rest}leted","data":{"id":3}}\nnot json\n`);
  assert.deepEqual(second.lines, [{ type: 'cycle.completed', data: { id: 3 } }]);
  assert.equal(second.rest, '');
});
