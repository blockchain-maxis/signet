import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpecJson } from '@signet/spec';
import { ContractChanges, type VersionSpecItem } from './contract-changelog.ts';

function makeSyntheticSpecs(): { v1: SpecJson; v2: SpecJson } {
  const v1: SpecJson = {
    schemaVersion: 1,
    wasmHash: '1111111111111111111111111111111111111111111111111111111111111111',
    sdkVersion: '16.1.0',
    entriesXdr: [],
    functions: [
      {
        name: 'transfer',
        inputs: [{ name: 'amount', type: 'u32' }],
        outputs: [],
        doc: '',
        isConstructor: false,
      },
    ],
    types: [],
    errors: [
      { enumName: 'Error', name: 'Unauthorized', value: 1, doc: '' },
      { enumName: 'Error', name: 'OldDeprecatedError', value: 2, doc: '' },
    ],
    events: [],
    warnings: [],
  };

  const v2: SpecJson = {
    schemaVersion: 1,
    wasmHash: '2222222222222222222222222222222222222222222222222222222222222222',
    sdkVersion: '16.1.0',
    entriesXdr: [],
    functions: [
      {
        name: 'transfer',
        inputs: [{ name: 'amount', type: 'u64' }], // retyped: breaking!
        outputs: [],
        doc: '',
        isConstructor: false,
      },
      {
        name: 'mint_tokens', // added function!
        inputs: [],
        outputs: [],
        doc: '',
        isConstructor: false,
      },
    ],
    types: [],
    errors: [
      { enumName: 'Error', name: 'Unauthorized', value: 1, doc: '' },
      // OldDeprecatedError removed!
    ],
    events: [],
    warnings: [],
  };

  return { v1, v2 };
}

test('ContractChanges: renders added function, removed error, and retyped argument marked breaking', () => {
  const { v1, v2 } = makeSyntheticSpecs();
  const versions: VersionSpecItem[] = [
    {
      wasmHash: v2.wasmHash,
      observedAt: '2026-03-02T10:00:00Z',
      spec: v2,
    },
    {
      wasmHash: v1.wasmHash,
      observedAt: '2026-03-01T10:00:00Z',
      spec: v1,
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(ContractChanges, {
      versions,
      network: 'testnet',
    }),
  );

  // Section heading
  assert.ok(html.includes('Changes'));

  // Added function
  assert.ok(html.includes('Added function mint_tokens'));

  // Removed error
  assert.ok(html.includes('Removed error') && html.includes('OldDeprecatedError'));

  // Retyped argument marked breaking
  assert.ok(html.includes('Retyped argument'));
  assert.ok(html.includes('breaking'));

  // Version headers
  assert.ok(html.includes('observed'));
});

test('ContractChanges: renders note when an old version interface is unretrievable', () => {
  const { v2 } = makeSyntheticSpecs();
  const oldHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const versions: VersionSpecItem[] = [
    {
      wasmHash: v2.wasmHash,
      observedAt: '2026-03-02T10:00:00Z',
      spec: v2,
    },
    {
      wasmHash: oldHash,
      observedAt: '2026-02-15T10:00:00Z',
      unretrievable: true,
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(ContractChanges, {
      versions,
      network: 'testnet',
    }),
  );

  assert.ok(html.includes(`Interface for ${oldHash} is no longer retrievable from testnet`));
});

test('ContractChanges: contract with one version shows no Changes section', () => {
  const { v1 } = makeSyntheticSpecs();
  const versions: VersionSpecItem[] = [
    {
      wasmHash: v1.wasmHash,
      observedAt: '2026-03-01T10:00:00Z',
      spec: v1,
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(ContractChanges, {
      versions,
      network: 'testnet',
    }),
  );

  assert.equal(html, '');
});
