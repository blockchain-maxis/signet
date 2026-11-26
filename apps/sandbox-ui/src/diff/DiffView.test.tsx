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
import realTxCycle from '../fixtures/cycles/real_tx_fidelity.json';
import { CycleTable, type Cycle } from '../App.tsx';

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

test('real transactions show real-tx badge, ledger, and link; low-fidelity is listed apart with reason, and its diffs do not count in the summary', async () => {
  view(realTxCycle);

  // Summary counts only saved_call (1 behavioural) and tx_high_fidelity (1 breaking).
  // tx_low_fidelity (5 breaking, 2 behavioural) must NOT be counted in summary.
  const summary = screen.getByLabelText('Cycle summary');
  expect(summary).toHaveTextContent('✕breaking 1');
  expect(summary).toHaveTextContent('!behavioural 1');

  // Listbox has low-fidelity section
  const list = screen.getByRole('listbox', { name: 'Calls in this cycle' });
  expect(list).toHaveTextContent('low-fidelity (not counted)');

  // High-fidelity option shows real tx badge
  const highOption = within(list).getByRole('option', { name: /tx_high_fidelity/ });
  expect(highOption).toHaveTextContent('real tx');

  // Low-fidelity option shows real tx badge and fidelity reason
  const lowOption = within(list).getByRole('option', { name: /tx_low_fidelity/ });
  expect(lowOption).toHaveTextContent('real tx');
  expect(lowOption).toHaveTextContent('low-fidelity (state changed since ledger 123450)');

  // Select high-fidelity real tx: detail shows badge, ledger, and link
  await userEvent.click(highOption);
  const detail = screen.getByRole('region', { name: 'Differences in tx_high_fidelity' });
  const realSec = within(detail).getByRole('region', { name: 'Real transaction' });
  expect(realSec).toHaveTextContent('real tx');
  expect(realSec).toHaveTextContent('ledger 123456');
  const link = within(realSec).getByRole('link', { name: /0123…def/ });
  expect(link).toHaveAttribute('href', (realTxCycle.outcomes[1] as any).real.link);
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  // Select low-fidelity real tx: detail shows badge, ledger, link, and reason
  await userEvent.click(lowOption);
  const lowDetail = screen.getByRole('region', { name: 'Differences in tx_low_fidelity' });
  const lowRealSec = within(lowDetail).getByRole('region', { name: 'Real transaction' });
  expect(lowRealSec).toHaveTextContent('real tx');
  expect(lowRealSec).toHaveTextContent('ledger 123450');
  expect(lowRealSec).toHaveTextContent('the deployed code fails here now');
});

test('CycleTable: real-tx row shows badge, ledger and link; low-fidelity row is listed apart with reason', () => {
  render(<CycleTable cycle={{ state: 'ok', value: realTxCycle as unknown as Cycle }} />);

  // Table has "low-fidelity (not counted)" subheader
  expect(screen.getByText('low-fidelity (not counted)')).toBeInTheDocument();

  // High-fidelity row has "real tx" badge, ledger, and link
  const highRow = screen.getByRole('row', { name: /tx_high_fidelity/ });
  expect(within(highRow).getByText('real tx')).toBeInTheDocument();
  expect(within(highRow).getByText('ledger 123456')).toBeInTheDocument();
  const highLink = within(highRow).getByRole('link');
  expect(highLink).toHaveAttribute('href', (realTxCycle.outcomes[1] as any).real.link);
  expect(highLink).toHaveAttribute('rel', 'noopener noreferrer');

  // Low-fidelity row has "real tx" badge, ledger, link, and reason
  const lowRow = screen.getByRole('row', { name: /tx_low_fidelity/ });
  expect(within(lowRow).getByText('real tx')).toBeInTheDocument();
  expect(within(lowRow).getByText('ledger 123450')).toBeInTheDocument();
  expect(within(lowRow).getByText(/low-fidelity \(state changed since ledger 123450\)/)).toBeInTheDocument();
});
