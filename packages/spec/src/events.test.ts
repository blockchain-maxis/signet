import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr } from '@stellar/stellar-sdk';
import { buildEvents } from './events.ts';
import { fixtureEntries } from './test-helpers.ts';

test('events.wasm produces the expected events', () => {
  assert.deepEqual(buildEvents(fixtureEntries('events')), [
    {
      name: 'Transfer',
      doc: 'A transfer between two accounts.',
      prefixTopics: ['transfer'],
      params: [
        { name: 'from', type: 'address', location: 'topic' },
        { name: 'to', type: 'address', location: 'topic' },
        { name: 'amount', type: 'i128', location: 'data' },
      ],
      dataFormat: 'map',
    },
    {
      name: 'Checkpoint',
      doc: 'A checkpoint with no topics.',
      prefixTopics: ['checkpoint'],
      params: [
        { name: 'seq', type: 'u32', location: 'data' },
        { name: 'tag', type: 'symbol', location: 'data' },
      ],
      dataFormat: 'map',
    },
  ]);
});

test('the registry fixture has no events: an empty list, not a failure', () => {
  assert.deepEqual(buildEvents(fixtureEntries('identity-registry')), []);
});

test('fixtures that declare no events yield an empty list', () => {
  for (const name of ['types_zoo', 'undocumented', 'errors_multi']) {
    assert.deepEqual(buildEvents(fixtureEntries(name)), [], name);
  }
});

test('every data format and param location maps, and absent docs are empty strings', () => {
  const make = (format: xdr.ScSpecEventDataFormat) =>
    xdr.ScSpecEntry.scSpecEntryEventV0(
      new xdr.ScSpecEventV0({
        doc: '',
        lib: '',
        name: 'E',
        prefixTopics: ['e'],
        params: [
          new xdr.ScSpecEventParamV0({
            doc: '',
            name: 'p',
            type: xdr.ScSpecTypeDef.scSpecTypeU32(),
            location: xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationTopicList(),
          }),
        ],
        dataFormat: format,
      }),
    );
  const events = buildEvents([
    make(xdr.ScSpecEventDataFormat.scSpecEventDataFormatSingleValue()),
    make(xdr.ScSpecEventDataFormat.scSpecEventDataFormatVec()),
    make(xdr.ScSpecEventDataFormat.scSpecEventDataFormatMap()),
  ]);
  assert.deepEqual(
    events.map((e) => e.dataFormat),
    ['single_value', 'vec', 'map'],
  );
  assert.equal(events[0]!.doc, '');
  assert.equal(events[0]!.params[0]!.location, 'topic');
});
