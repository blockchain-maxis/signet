import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractNotFound } from './contract-not-found.ts';

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

test('names the handle, links its profile, and links the address to the explorer', () => {
  const m = buildContractNotFound({ handle: 'alice', address: ADDRESS });

  assert.equal(m.heading, 'Contract not found');
  assert.equal(m.handle, 'alice');
  assert.equal(m.body[0], "This contract isn't part of @alice's record.");
  assert.equal(m.profileHref, '/p/alice');
  assert.ok(m.explorerHref?.startsWith('https://stellar.expert/explorer/'));
  assert.ok(m.explorerHref?.endsWith(`/contract/${ADDRESS}`));
});

test('a wrong-handle link stays useful: both exits are present together', () => {
  const m = buildContractNotFound({ handle: 'bob', address: ADDRESS });
  assert.notEqual(m.profileHref, null);
  assert.notEqual(m.explorerHref, null);
});

test('an address that is not shaped like a contract has no explorer link and says so', () => {
  for (const address of ['', 'not-an-address', 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI', ADDRESS.slice(1)]) {
    const m = buildContractNotFound({ handle: 'alice', address });
    assert.equal(m.explorerHref, null, address);
    assert.match(m.body[1]!, /doesn't look like a contract address/);
  }
});

test('a handle the registry could not contain is never echoed and gets no profile link', () => {
  for (const handle of ['', 'Alice', '<script>', 'a b', '../admin', 'x'.repeat(200)]) {
    const m = buildContractNotFound({ handle, address: ADDRESS });
    assert.equal(m.handle, null, handle);
    assert.equal(m.profileHref, null, handle);
    assert.equal(m.body[0], "This contract isn't part of this developer's record.");
    assert.ok(!m.body.join(' ').includes(handle) || handle === '');
  }
});

test('missing params are handled without throwing', () => {
  const m = buildContractNotFound({});
  assert.equal(m.profileHref, null);
  assert.equal(m.explorerHref, null);
  assert.equal(m.heading, 'Contract not found');
});

test('array params, which useParams can return for catch-all segments, use the first entry', () => {
  const m = buildContractNotFound({ handle: ['alice', 'extra'], address: [ADDRESS] });
  assert.equal(m.handle, 'alice');
  assert.notEqual(m.explorerHref, null);
});
