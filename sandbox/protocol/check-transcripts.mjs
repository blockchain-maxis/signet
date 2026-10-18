#!/usr/bin/env node
/**
 * Validates the golden transcripts in sandbox/protocol/transcripts/*.ndjson against the JSON
 * Schemas in sandbox/protocol/schema/v1/, and checks that every schema is documented.
 *
 *   node sandbox/protocol/check-transcripts.mjs
 *
 * How a line is matched to a schema:
 *   - a request or notification (hello, ledger_open, simulate, ledger_fetch, ledger_entries, ...)
 *     is validated against the schema named by its `type`;
 *   - a `result` is validated against the `result` definition of the request with the same `id`;
 *   - `hello_ack`, `contract_error` and `error` are validated against their own schemas.
 *   - A request answered by an `error` with the same id is the malformed input that error is
 *     about (an unknown type, a wrong version, a bad field), so it is not required to validate.
 *
 * Needs `ajv` (8.x). It is found next to this script, or in apps/web, which already depends on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const schemaDir = path.join(here, 'schema/v1');
const transcriptDir = path.join(here, 'transcripts');
const bridgeDoc = path.join(root, 'docs/CLI_RUST_BRIDGE.md');
const SCHEMA_ID = (type) => `https://signet.dev/schemas/sandbox/v1/${type}.json`;

function loadAjv() {
  for (const from of [import.meta.url, path.join(root, 'apps/web/package.json')]) {
    try {
      const mod = createRequire(from)('ajv');
      return mod.default ?? mod;
    } catch {
      // try the next place
    }
  }
  console.error('check-transcripts: cannot find the `ajv` package (run `pnpm install`).');
  process.exit(2);
}

const Ajv = loadAjv();
const ajv = new Ajv({ strict: true, allErrors: true });
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

const schemaTypes = fs
  .readdirSync(schemaDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
for (const type of schemaTypes) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, `${type}.json`), 'utf8'));
  if (schema.$id !== SCHEMA_ID(type))
    fail(`schema/v1/${type}.json`, `$id must be ${SCHEMA_ID(type)}`);
  try {
    ajv.addSchema(schema);
  } catch (e) {
    fail(`schema/v1/${type}.json`, e.message);
  }
}

// Every message type has to appear in the bridge note's catalogue.
const doc = fs.readFileSync(bridgeDoc, 'utf8');
for (const type of schemaTypes) {
  if (!doc.includes(`\`${type}\``))
    fail('docs/CLI_RUST_BRIDGE.md', `message type \`${type}\` has a schema but is not documented`);
}

const OWN_SCHEMA = new Set(['hello_ack', 'contract_error', 'error']);
const validate = (id, where, value) => {
  const check = ajv.getSchema(id);
  if (!check) return fail(where, `no schema ${id}`);
  if (!check(value)) {
    for (const e of check.errors)
      fail(
        where,
        `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues})` : ''}`,
      );
  }
};

let lines = 0;
const transcripts = fs
  .readdirSync(transcriptDir)
  .filter((f) => f.endsWith('.ndjson'))
  .sort();
if (transcripts.length === 0) fail('transcripts', 'no transcripts found');
for (const name of transcripts) {
  const rows = fs
    .readFileSync(path.join(transcriptDir, name), 'utf8')
    .split(/\r?\n/)
    .map((text, i) => ({ text, no: i + 1 }))
    .filter((r) => r.text.trim() !== '');

  const messages = [];
  for (const r of rows) {
    try {
      messages.push({ ...r, value: JSON.parse(r.text) });
    } catch (e) {
      fail(`${name}:${r.no}`, `not JSON: ${e.message}`);
    }
  }

  // ids an `error` answers: the request with that id is the malformed input.
  const refused = new Set(
    messages.filter((m) => m.value.type === 'error' && m.value.id).map((m) => m.value.id),
  );
  const requestType = new Map();

  for (const m of messages) {
    lines++;
    const where = `${name}:${m.no}`;
    const { type, id } = m.value;
    if (OWN_SCHEMA.has(type) || type === 'ledger_fetch' || type === 'ledger_entries') {
      validate(SCHEMA_ID(type), where, m.value);
    } else if (type === 'result') {
      const req = requestType.get(id);
      if (!req) fail(where, `result for id ${JSON.stringify(id)} has no earlier request`);
      else validate(`${SCHEMA_ID(req)}#/definitions/result`, where, m.value);
    } else {
      requestType.set(id, type);
      if (refused.has(id)) continue; // the malformed input an error is about
      if (!schemaTypes.includes(type))
        fail(where, `unknown message type ${JSON.stringify(type)} with no error answering it`);
      else validate(SCHEMA_ID(type), where, m.value);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  console.error(`\ncheck-transcripts: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(
  `check-transcripts: ok — ${schemaTypes.length} schemas, ${transcripts.length} transcripts, ${lines} lines`,
);
