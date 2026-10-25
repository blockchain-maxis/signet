import { expect, test } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffView, type DiffCycle } from './DiffView.tsx';
// Real reload cycles over the #529 fixture contracts, recorded by
// cli/internal/dev's TestRecordUICycleFixtures.
import returnChange from '../fixtures/cycles/counter_v2_return.json';
import authChange from '../fixtures/cycles/auth_signer_changed.json';
import signatureChange from '../fixtures/cycles/counter_v2_auth.json';
import layoutFinding from '../fixtures/cycles/profile_v2_field.json';

const view = (c: unknown) => render(<DiffView cycle={c as DiffCycle} />);

test('a return change: per-item summaries, and the value side by side at its path', () => {
  view(returnChange);
  const list = screen.getByRole('listbox', { name: 'Calls in this cycle' });
  expect(within(list).getByRole('option', { name: /get/ })).toHaveTextContent('1 breaking, 3 cost');
  const detail = screen.getByRole('region', { name: 'Differences in get' });
  const ret = within(detail).getByRole('region', { name: 'Return value' });
  expect(ret).toHaveTextContent('Deployed (A)u32 0');
  expect(ret).toHaveTextContent('Build (B)i128 "0"');
  expect(ret).toHaveTextContent('breaking');
  // Severities carry a glyph and a word, not colour alone.
  expect(within(ret).getByText('breaking').parentElement).toHaveTextContent('✕breaking');
  expect(within(detail).getByRole('region', { name: 'Resources' })).toHaveTextContent('instructions');
  expect(screen.getByRole('region', { name: 'Spec findings' })).toHaveTextContent('breaking');
});

test('arrow keys move between calls, and the detail follows', async () => {
  view(returnChange);
  const options = screen.getAllByRole('option');
  options[0]!.focus();
  await userEvent.keyboard('{ArrowDown}');
  expect(options[1]).toHaveFocus();
  expect(options[1]).toHaveAttribute('aria-selected', 'true');
  const detail = screen.getByRole('region', { name: 'Differences in increment' });
  expect(within(detail).getByRole('table', { name: 'Storage writes' })).toHaveTextContent('/value/storage/count');
  await userEvent.keyboard('{ArrowUp}');
  expect(options[0]).toHaveFocus();
});

test('an auth change names the signers and is marked client-breaking', () => {
  view(authChange);
  const auth = screen.getByRole('region', { name: 'Auth' });
  expect(auth).toHaveTextContent('client-breaking');
  expect(auth).toHaveTextContent('+ signer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  expect(auth).toHaveTextContent('− signer GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
});

test("a build that takes a new argument refuses the saved call: the outcome changes", async () => {
  view(signatureChange);
  await userEvent.click(screen.getByRole('option', { name: /increment/ }));
  const outcome = screen.getByRole('region', { name: 'Outcome' });
  expect(outcome).toHaveTextContent('Deployed (A)ok');
  expect(outcome).toHaveTextContent('Build (B)call error Refused');
});

test('layout findings show their evidence, static and replay', () => {
  view(layoutFinding);
  const layout = screen.getByRole('region', { name: 'Layout findings' });
  expect(layout).toHaveTextContent('static: the specs say so');
  expect(layout).toHaveTextContent('replay: a call failed reading it');
  expect(layout).toHaveTextContent('age: field missing from Profile');
});
