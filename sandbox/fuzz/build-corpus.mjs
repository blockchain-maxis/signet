#!/usr/bin/env node
// Builds the fuzz seed corpus (#525) from the protocol transcripts (#522) in
// sandbox/protocol/transcripts: real exchanges, so the fuzzer starts from
// messages the simulator accepts.
//
//   node sandbox/fuzz/build-corpus.mjs
//
// corpus/framing     each transcript, whole (requests and replies)
// corpus/dispatch    each transcript's requests, as one session
// corpus/xdr_params  every base64 XDR value in them, decoded, behind a lane byte
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const transcripts = join(here, '../protocol/transcripts');
const corpus = join(here, 'corpus');

const put = (target, bytes) => {
  const dir = join(corpus, target);
  mkdirSync(dir, { recursive: true });
  const name = createHash('sha1').update(bytes).digest('hex');
  writeFileSync(join(dir, name), bytes);
};

for (const target of ['framing', 'dispatch', 'xdr_params']) rmSync(join(corpus, target), { recursive: true, force: true });

const xdrValues = new Set();
const collect = (value, key = '') => {
  if (Array.isArray(value)) value.forEach((v) => collect(v, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
  else if (typeof value === 'string' && /(^|_)xdr$/.test(key) && value.length > 0) xdrValues.add(value);
};

for (const file of readdirSync(transcripts).filter((f) => f.endsWith('.ndjson')).sort()) {
  const text = readFileSync(join(transcripts, file));
  put('framing', text);
  const lines = text.toString('utf8').split('\n').filter(Boolean);
  // Requests are the lines the client wrote: they open with the version.
  const requests = lines.filter((l) => l.startsWith('{"version":1'));
  put('dispatch', Buffer.from(requests.join('\n') + '\n'));
  for (const line of lines) collect(JSON.parse(line));
}
for (const value of [...xdrValues].sort()) {
  const bytes = Buffer.from(value, 'base64');
  for (const lane of [0, 1]) put('xdr_params', Buffer.concat([Buffer.from([lane]), bytes]));
}
for (const target of ['framing', 'dispatch', 'xdr_params']) {
  console.log(`${target}: ${readdirSync(join(corpus, target)).length} seeds`);
}
