#!/usr/bin/env node
/**
 * Runs the built signet-simulator's `spec_extract` (#545) over every
 * packages/spec fixture and validates each `spec` against the SpecJson v1
 * schema (packages/spec/schema/spec-json.v1.schema.json), the same schema
 * the TS reader's output is held to.
 *
 *   cargo build -p signet-simulator && node sandbox/protocol/check-spec-json.mjs
 *
 * SIGNET_SIMULATOR_PATH overrides the binary (default: sandbox/target/debug).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixtures = path.join(root, 'packages/spec/fixtures');
const exe = process.platform === 'win32' ? 'signet-simulator.exe' : 'signet-simulator';
const binary = process.env.SIGNET_SIMULATOR_PATH || path.join(here, '../target/debug', exe);

function loadAjv() {
  for (const from of [import.meta.url, path.join(root, 'apps/web/package.json')]) {
    try {
      const mod = createRequire(from)('ajv');
      return mod.default ?? mod;
    } catch {
      // try the next place
    }
  }
  console.error('check-spec-json: cannot find the `ajv` package (run `pnpm install`).');
  process.exit(2);
}

if (!fs.existsSync(binary)) {
  console.error(`check-spec-json: no simulator at ${binary} (cargo build -p signet-simulator)`);
  process.exit(2);
}

const Ajv = loadAjv();
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(
  JSON.parse(
    fs.readFileSync(path.join(root, 'packages/spec/schema/spec-json.v1.schema.json'), 'utf8'),
  ),
);

const names = fs
  .readdirSync(fixtures)
  .filter((f) => f.endsWith('.wasm'))
  .sort();
const lines = [{ version: 1, id: 'hello', type: 'hello', client_protocol_version: 1 }];
for (const name of names) {
  const wasm = fs.readFileSync(path.join(fixtures, name)).toString('base64');
  lines.push({ version: 1, id: name, type: 'spec_extract', source: { wasm_base64: wasm } });
}
const run = spawnSync(binary, [], {
  input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  maxBuffer: 256 * 1024 * 1024,
});
if (run.status !== 0) {
  console.error(`check-spec-json: simulator exited ${run.status}: ${run.stderr}`);
  process.exit(1);
}

const errors = [];
let checked = 0;
for (const reply of run.stdout
  .toString()
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => JSON.parse(l))) {
  if (reply.type !== 'result') {
    // A module the reader refuses (no spec section is fine; a corrupt one is
    // an error the TS reader raises too) has nothing to validate.
    continue;
  }
  checked += 1;
  if (!validate(reply.spec)) {
    errors.push(`${reply.id}: ${ajv.errorsText(validate.errors)}`);
  }
}
if (errors.length > 0) {
  console.error(
    `check-spec-json: ${errors.length} document(s) fail SpecJson v1:\n  ${errors.join('\n  ')}`,
  );
  process.exit(1);
}
if (checked === 0) {
  console.error('check-spec-json: no fixture produced a spec');
  process.exit(1);
}
console.log(
  `check-spec-json: ok — ${checked} of ${names.length} fixtures validate against SpecJson v1`,
);
