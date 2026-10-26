#!/usr/bin/env node
// Imports the built package as a plain Node consumer would (no TypeScript
// loader) and makes one call through it against a stub fetch (#655).
import assert from 'node:assert/strict';
import { SignetClient, NotFoundError } from '../dist/index.js';

const asked = [];
const client = new SignetClient({
  baseUrl: 'http://signet.test',
  fetch: async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ data: { status: 'ok', apiVersion: '1' } }));
  },
});
assert.deepEqual(await client.getHealth(), { status: 'ok', apiVersion: '1' });
assert.deepEqual(asked, ['http://signet.test/api/v1/health']);
assert.equal(new NotFoundError().status, 404);
console.log('smoke-node: dist/index.js imports and calls getHealth');
