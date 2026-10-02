import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_SCOPE_NOTE,
  FUNCTION_ANCHOR_PREFIX,
  findFunction,
  firstDocParagraph,
  functionAnchor,
  functionArguments,
  functionBacklinkHref,
  functionErrorCases,
  functionPermalinkDescription,
  functionPermalinkHref,
  functionPermalinkTitle,
  functionReferencedTypes,
  functionReturnsError,
  functionSignature,
  functionsTabHref,
  resolveFunctionPage,
  shortAddress,
  type ContractSpecLike,
  type FunctionSourceResult,
} from './function-permalink.ts';
import type {
  SpecErrorCase,
  SpecFunction,
  SpecStruct,
  SpecType,
  TypeRef,
} from '@signet/spec';

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

function fn(over: Partial<SpecFunction> & { name: string }): SpecFunction {
  return { doc: '', isConstructor: false, inputs: [], outputs: [], ...over };
}

/** The deployed registry's `claim`, per design §2.3 and #430's acceptance. */
const CLAIM = fn({
  name: 'claim',
  doc: 'Claims a human-readable handle for the calling wallet.',
  inputs: [
    { name: 'handle', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  outputs: [{ type: 'result', ok: 'void', error: 'error' }],
});

const POOL: SpecStruct = {
  kind: 'struct',
  name: 'Pool',
  doc: 'A liquidity pool.',
  fields: [
    { name: 'a', type: 'address' },
    { name: 'b', type: 'address' },
  ],
};

const STATUS: SpecType = { kind: 'enum', name: 'Status', variants: [{ name: 'Live', value: 0 }] };

const REGISTRY_ERRORS: readonly SpecErrorCase[] = [
  { enumName: 'Error', name: 'HandleTaken', value: 2, doc: 'The handle is already bound.' },
  { enumName: 'Error', name: 'NotOwner', value: 4, doc: '' },
  { enumName: 'Error', name: 'InvalidHandle', value: 5, doc: '' },
];

test('the permalink hangs under the Functions tab the tab bar links to', () => {
  assert.equal(functionsTabHref('alice', ADDRESS), `/p/alice/contract/${ADDRESS}/functions`);
  assert.equal(
    functionPermalinkHref('alice', ADDRESS, 'claim'),
    `/p/alice/contract/${ADDRESS}/functions/claim`,
  );
});

test('the backlink carries the anchor the Functions tab documents (#473)', () => {
  assert.equal(FUNCTION_ANCHOR_PREFIX, 'fn-');
  assert.equal(functionAnchor('claim'), 'fn-claim');
  assert.equal(
    functionBacklinkHref('alice', ADDRESS, 'claim'),
    `/p/alice/contract/${ADDRESS}/functions#fn-claim`,
  );
});

test('a signature reads the way the contract source does', () => {
  assert.equal(
    functionSignature(CLAIM),
    'claim(handle: String, wallet: Address) -> Result<(), Error>',
  );
});

test('containers unwrap to the type underneath', () => {
  const nested = fn({
    name: 'swap',
    inputs: [
      { name: 'pools', type: { type: 'option', value: { type: 'vec', element: { type: 'named', name: 'Pool' } } } },
      { name: 'index', type: { type: 'map', key: 'string', value: { type: 'bytes_n', n: 32 } } },
    ],
    outputs: [{ type: 'tuple', elements: ['u64', { type: 'named', name: 'Status' }] }],
  });
  assert.equal(
    functionSignature(nested),
    'swap(pools: Option<Vec<Pool>>, index: Map<String, BytesN<32>>) -> (u64, Status)',
  );
});

test('an absent or unfamiliar type arm renders as unknown, never as a guess', () => {
  const future: TypeRef = { type: 'unknown', xdrArm: 'scSpecTypeSomethingNew' };
  assert.equal(functionSignature(fn({ name: 'f', outputs: [future] })), 'f() -> unknown');
  assert.equal(functionSignature(fn({ name: 'f', outputs: [] })), 'f() -> ()');
});

test('an error in the return type is found through every container', () => {
  assert.equal(functionReturnsError(CLAIM), true);
  assert.equal(
    functionReturnsError(
      fn({ name: 'f', outputs: [{ type: 'option', value: { type: 'vec', element: 'error' } }] }),
    ),
    true,
  );
  assert.equal(
    functionReturnsError(fn({ name: 'f', outputs: [{ type: 'map', key: 'string', value: 'address' }] })),
    false,
  );
});

test('referenced types are unwrapped, deduplicated, and left in spec order', () => {
  const swap = fn({
    name: 'swap',
    inputs: [
      { name: 'a', type: { type: 'option', value: { type: 'named', name: 'Status' } } },
      { name: 'b', type: { type: 'vec', element: { type: 'named', name: 'Pool' } } },
      { name: 'c', type: { type: 'named', name: 'Pool' } },
      { name: 'd', type: { type: 'result', ok: { type: 'named', name: 'Status' }, error: 'error' } },
    ],
  });
  const types: readonly SpecType[] = [POOL, STATUS];
  // `types` declares Pool first, so the result follows the spec, not the args.
  assert.deepEqual(
    functionReferencedTypes(swap, types).map((t) => t.name),
    ['Pool', 'Status'],
  );
});

test('a dangling type reference is dropped rather than linked to nothing', () => {
  const dangling = fn({ name: 'f', inputs: [{ name: 'a', type: { type: 'named', name: 'Gone' } }] });
  assert.deepEqual(functionReferencedTypes(dangling, [POOL, STATUS]), []);
});

test('errors are listed only for a function whose return type carries one', () => {
  assert.equal(functionErrorCases(CLAIM, REGISTRY_ERRORS).length, 3);
  assert.deepEqual(functionErrorCases(fn({ name: 'f' }), REGISTRY_ERRORS), []);
  // The list says which errors the contract defines, never which one fires.
  assert.match(ERROR_SCOPE_NOTE, /not which ones this function returns/);
});

test('the description is the contract\'s first paragraph, or its signature', () => {
  assert.equal(
    functionPermalinkDescription(CLAIM),
    'Claims a human-readable handle for the calling wallet.',
  );
  const undocumented = fn({ name: 'claim', inputs: CLAIM.inputs, outputs: CLAIM.outputs });
  assert.equal(functionPermalinkDescription(undocumented), functionSignature(undocumented));
});

test('a doc comment contributes its first paragraph only', () => {
  assert.equal(
    firstDocParagraph('First line\nwrapped.\n\n## Arguments\n\n- one'),
    'First line wrapped.',
  );
  assert.equal(firstDocParagraph('  \n\n  '), undefined);
  // #430 fixes an absent doc to `''`, so both spellings mean the same thing.
  assert.equal(firstDocParagraph(''), undefined);
  assert.equal(firstDocParagraph(undefined), undefined);
});

test('the title names the function, the contract and the handle', () => {
  assert.equal(
    functionPermalinkTitle({ name: 'claim', address: ADDRESS, handle: 'alice' }),
    'claim · CASFJHI5...FUJRCN · alice',
  );
  assert.equal(shortAddress('CASFJHI5PQ'), 'CASFJHI5PQ');
});

test('a function is matched exactly, so Claim is not claim', () => {
  assert.equal(findFunction([CLAIM], 'claim'), CLAIM);
  assert.equal(findFunction([CLAIM], 'Claim'), undefined);
  assert.equal(findFunction([CLAIM], 'claim '), undefined);
});

function source(spec: ContractSpecLike): FunctionSourceResult {
  return { ok: true, spec };
}

test('a resolved interface and a resolved name render the function', () => {
  const state = resolveFunctionPage(
    source({ functions: [CLAIM], types: [POOL], errors: REGISTRY_ERRORS }),
    'claim',
  );
  assert.equal(state.kind, 'function');
  if (state.kind !== 'function') return;
  assert.equal(state.fn.name, 'claim');
  assert.deepEqual(state.errors, REGISTRY_ERRORS);
  assert.deepEqual(functionArguments(state.fn), [
    { name: 'handle', type: 'String', doc: undefined },
    { name: 'wallet', type: 'Address', doc: undefined },
  ]);
});

test('a name the interface does not export is a 404', () => {
  assert.deepEqual(
    resolveFunctionPage(source({ functions: [CLAIM], types: [], errors: [] }), 'nope'),
    { kind: 'unknown-function' },
  );
});

test('an unreadable interface is not a 404, because the URL may be right', () => {
  assert.deepEqual(resolveFunctionPage({ ok: false, reason: 'spec_reader_unavailable' }, 'claim'), {
    kind: 'interface-unavailable',
    reason: 'spec_reader_unavailable',
  });
});
