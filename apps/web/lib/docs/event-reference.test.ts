import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson, type SpecJson } from '@signet/spec';
import { eventAnchor, typeAnchor } from './anchors.ts';
import { NO_EVENTS_NOTE, buildEventReference } from './event-reference.ts';
import { typesTabHref } from './function-reference.ts';
import { buildTypeReference } from './type-reference.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'spec',
  'fixtures',
);

function fixture(name: string): SpecJson {
  return toSpecJson(parseContractSpec(readFileSync(join(FIXTURES, `${name}.wasm`))));
}

const HREF = typesTabHref('dev', 'CABC');

test('events.wasm lists every declared event, its params and their locations', () => {
  const spec = fixture('events');
  const ref = buildEventReference(spec, HREF);

  assert.equal(ref.isEmpty, false);
  assert.equal(ref.note, null);
  assert.deepEqual(ref.events, [
    {
      name: 'Transfer',
      id: eventAnchor('Transfer'),
      doc: 'A transfer between two accounts.',
      prefixTopics: ['transfer'],
      params: [
        { name: 'from', type: [{ text: 'Address' }], location: 'topic' },
        { name: 'to', type: [{ text: 'Address' }], location: 'topic' },
        { name: 'amount', type: [{ text: 'i128' }], location: 'data' },
      ],
      dataFormat: 'map',
    },
    {
      name: 'Checkpoint',
      id: eventAnchor('Checkpoint'),
      doc: 'A checkpoint with no topics.',
      prefixTopics: ['checkpoint'],
      params: [
        { name: 'seq', type: [{ text: 'u32' }], location: 'data' },
        { name: 'tag', type: [{ text: 'Symbol' }], location: 'data' },
      ],
      dataFormat: 'map',
    },
  ]);
});

test('contracts without events yield the empty state note', () => {
  const spec = fixture('identity-registry');
  const ref = buildEventReference(spec, HREF);

  assert.equal(ref.isEmpty, true);
  assert.deepEqual(ref.events, []);
  assert.equal(ref.note, NO_EVENTS_NOTE);
});

test('types referenced only by event params are included in TypeReference and linked', () => {
  const synthetic: SpecJson = {
    schemaVersion: 1,
    wasmHash: '0'.repeat(64),
    sdkVersion: '16.1.0',
    entriesXdr: [],
    functions: [],
    types: [
      {
        kind: 'struct',
        name: 'TransferMeta',
        doc: '',
        fields: [{ name: 'memo', type: 'string', doc: '' }],
      },
    ],
    errors: [],
    events: [
      {
        name: 'TransferWithMeta',
        doc: '',
        prefixTopics: ['xfer'],
        params: [{ name: 'meta', type: { type: 'named', name: 'TransferMeta' }, location: 'data' }],
        dataFormat: 'single_value',
      },
    ],
    warnings: [],
  };

  const typeRef = buildTypeReference(synthetic, HREF);
  assert.deepEqual(
    typeRef.used.map((t) => t.name),
    ['TransferMeta'],
  );

  const eventRef = buildEventReference(synthetic, HREF);
  assert.deepEqual(eventRef.events[0]!.params[0]!.type, [
    { text: 'TransferMeta', href: `${HREF}#${typeAnchor('TransferMeta')}` },
  ]);
  assert.equal(eventRef.events[0]!.dataFormat, 'single value');
});
