import { expect, test } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { SpecJson } from '@signet/spec';
import { NOTHING_SUBMITTED, ResultPanel } from './ResultPanel.tsx';
import type { CallResultView } from './result.ts';
import registry from '../fixtures/identity-registry.spec.json';
// Recorded from `signet sandbox call --json` against the testnet registry.
import read from '../fixtures/calls/read.json';
import write from '../fixtures/calls/write-preview.json';
import contractError from '../fixtures/calls/contract-error.json';
import hostError from '../fixtures/calls/host-error.json';

const NOW = Date.parse('2026-10-25T22:21:52Z');
const panel = (result: unknown, fn: string) =>
  render(<ResultPanel result={result as CallResultView} target="deployed" fn={fn} spec={registry as SpecJson} now={NOW} />);

test('a read shows the value, natively', () => {
  panel(read, 'count');
  const card = screen.getByRole('article', { name: 'Read: count' });
  expect(card).toHaveTextContent('3');
  expect(card).not.toHaveTextContent('nothing was submitted');
  const provenance = within(card).getByRole('list', { name: 'Provenance' });
  expect(provenance).toHaveTextContent('testnet');
  expect(provenance).toHaveTextContent('fork ledger 5388497, 14 min old');
  expect(provenance).toHaveTextContent('no drift seen');
  expect(provenance).toHaveTextContent('auth mocked (record)');
});

test('a write is a preview, names its signer, and says nothing was submitted', () => {
  panel(write, 'claim');
  const card = screen.getByRole('article', { name: 'Write preview: claim' });
  // The line the design note requires on every write preview: do not remove it.
  expect(within(card).getByTestId('nothing-submitted')).toHaveTextContent('nothing was submitted');
  expect(NOTHING_SUBMITTED).toMatch(/^Local sandbox: nothing was submitted\.$/);
  expect(card).toHaveTextContent('Submitting this would need a signature from GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
  const writes = within(card).getByRole('table', { name: 'Storage writes' });
  expect(writes).toHaveTextContent('CASF…JRCN persistent ["Owner","uiwritefixture"]');
  expect(writes).toHaveTextContent('GAAZ…CWN7 auth nonce');
  expect(writes).toHaveTextContent('created');
  expect(card).toHaveTextContent('claimed · uiwritefixture');
  expect(card).toHaveTextContent('141412 stroops');
  // Raw XDR is there, folded away.
  const raw = within(card).getByText('Raw XDR').closest('details')!;
  expect(raw).not.toHaveAttribute('open');
});

test('a contract error is an expected outcome, with its name and code', () => {
  panel(contractError, 'claim');
  const card = screen.getByRole('article', { name: 'Contract error: claim' });
  expect(card).toHaveTextContent('HandleTaken (code 3)');
  expect(card).toHaveTextContent('an expected outcome, not a crash');
  expect(card).not.toHaveTextContent('nothing was submitted');
  expect(card.className).not.toMatch(/border-bad/);
});

test('a host error is shown apart from a contract error', () => {
  panel(hostError, 'count');
  const card = screen.getByRole('article', { name: 'Host error: count' });
  expect(card).toHaveTextContent('Error(Budget, ExceededLimit)');
  expect(card.className).toMatch(/border-bad/);
  expect(within(card).getByRole('list', { name: 'Provenance' })).toHaveTextContent('budget overridden');
});
