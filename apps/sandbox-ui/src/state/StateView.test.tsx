import { expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SpecJson } from '@signet/spec';
import type { Api } from '../api.ts';
import { StateView } from './StateView.tsx';
import type { ForkEntry, Override } from './state.ts';
import registry from '../fixtures/identity-registry.spec.json';

const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const LEDGER = 5_388_497;

// The registry's fork as GET /api/state?layer=fork returns it (decoded by entries_describe).
const fork: ForkEntry[] = [
  {
    key: 'AAAABgAAAAEkVJ0dfCUbS+muuiL8rmRUioX7jeL9k0Y+hV4EQDfLRAAAABQAAAAB',
    live_until_ledger_seq: 5_451_132,
    decoded: {
      kind: 'instance',
      contract: REGISTRY,
      executable: 'wasm 936996c7',
      storage: [
        { key: ['Admin'], value: WALLET },
        { key: ['Count'], value: 3 },
      ],
    },
  },
  {
    key: 'k-owner',
    live_until_ledger_seq: 5_509_456,
    provenance: { fetched_at_ledger: LEDGER, drifted: true },
    decoded: { kind: 'contract_data', contract: REGISTRY, durability: 'persistent', key: ['Owner', 'alice'], value: WALLET },
  },
  {
    key: 'k-temp',
    live_until_ledger_seq: 5_000_000,
    decoded: { kind: 'contract_data', contract: REGISTRY, durability: 'temporary', key: ['Nonce', 7], value: true },
  },
];

function fakeApi(overrides: Override[] = []) {
  const post = vi.fn(async () => ({ id: 'ui-1' }));
  const del = vi.fn(async () => undefined);
  const get = vi.fn(async (path: string) => {
    if (path === 'state?layer=fork') return { layer: 'fork', entries: fork };
    if (path === 'state?layer=override') return { layer: 'override', overrides };
    return { layer: 'session', entries: [], note: 'the session is rolled back to base between cycles' };
  });
  const api = { get, post, del, events: vi.fn() } as unknown as Api;
  return { api, post, del };
}

/** The text input a label names (the type select is labelled too). */
const field = (form: HTMLElement, name: RegExp) =>
  within(form).getAllByLabelText(name).find((e) => e.tagName === 'INPUT')!;

const view = (api: Api, consistent = false) =>
  render(<StateView api={api} ledger={LEDGER} consistent={consistent} spec={registry as SpecJson} refresh={0} />);

test('entries show decoded keys, TTLs against the fork ledger, and drift', async () => {
  const { api } = fakeApi();
  view(api);
  const table = await screen.findByRole('table');
  expect(table).toHaveTextContent('instance Admin');
  expect(table).toHaveTextContent('persistent Owner("alice")');
  const owner = within(table).getByText('persistent Owner("alice")').closest('tr')!;
  expect(owner).toHaveAttribute('data-drifted', 'true');
  expect(within(owner).getByText('drifted')).toBeInTheDocument();
  expect(owner).toHaveTextContent('live until 5509456, 120959 ledgers left');
  const temp = within(table).getByText('temporary Nonce(7)').closest('tr')!;
  expect(temp).toHaveTextContent('archived (live until 5000000)');
  expect(temp).not.toHaveAttribute('data-drifted');
});

test('a lazy fork says it is not the full storage; a snapshot fork says it is complete', async () => {
  const { api } = fakeApi();
  const { unmount } = view(api, false);
  expect(await screen.findByTestId('completeness')).toHaveTextContent('Not the full storage');
  unmount();
  view(api, true);
  expect(await screen.findByTestId('completeness')).toHaveTextContent(`Complete: every entry of the contract at ledger ${LEDGER}.`);
});

test('overriding an entry posts the #559 syntax', async () => {
  const { api, post } = fakeApi();
  view(api);
  await userEvent.click(await screen.findByRole('button', { name: 'override persistent Owner("alice")' }));
  const form = screen.getByRole('form', { name: 'Add an override' });
  expect(within(form).getByRole('textbox', { name: 'key expression' })).toHaveValue('Owner("alice")');
  await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'value type' }), 'address');
  await userEvent.type(field(form, /^value\b/), WALLET);
  await userEvent.click(within(form).getByRole('button', { name: 'Add override' }));
  expect(post).toHaveBeenCalledWith('overrides', {
    durability: 'persistent',
    key: 'Owner("alice")',
    value: `address:"${WALLET}"`,
  });
});

test('a typed key and value, or an unset, from the add form', async () => {
  const { api, post } = fakeApi();
  view(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Add an override' }));
  const form = screen.getByRole('form', { name: 'Add an override' });
  await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'key type' }), 'symbol');
  await userEvent.type(field(form, /^key\b/), 'count');
  await userEvent.type(field(form, /^value\b/), '5');
  await userEvent.selectOptions(within(form).getAllByRole('combobox')[0]!, 'instance');
  await userEvent.click(within(form).getByRole('button', { name: 'Add override' }));
  expect(post).toHaveBeenLastCalledWith('overrides', { durability: 'instance', key: 'symbol:"count"', value: 'u32:5' });

  await userEvent.click(await screen.findByRole('button', { name: 'Add an override' }));
  const again = screen.getByRole('form', { name: 'Add an override' });
  await userEvent.click(within(within(again).getByRole('radiogroup', { name: 'key as' })).getByRole('radio', { name: 'storage expression' }));
  await userEvent.type(within(again).getByRole('textbox', { name: 'key expression' }), 'Owner("bob")');
  await userEvent.click(within(again).getByRole('checkbox', { name: /remove the key/ }));
  await userEvent.click(within(again).getByRole('button', { name: 'Add override' }));
  expect(post).toHaveBeenLastCalledWith('overrides', { durability: 'persistent', key: 'Owner("bob")', unset: true });
});

test("the UI's overrides can be deleted; the file's are labelled", async () => {
  const { api, del } = fakeApi([
    { id: 'file-1', durability: 'instance', key: 'symbol:"count"', value: 'u32:9' },
    { id: 'ui-2', durability: 'persistent', key: 'Owner("alice")', unset: true },
  ]);
  view(api);
  await userEvent.click(await screen.findByRole('tab', { name: /Overrides/ }));
  expect(screen.getByText('from signet.dev.toml')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'delete override Owner("alice")' }));
  expect(del).toHaveBeenCalledWith('overrides/ui-2');
});
