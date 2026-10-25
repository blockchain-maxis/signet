import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api, SessionEvent } from './api.ts';
import cycle1 from './fixtures/cycles/counter_v2_return.json';

/** An event stream the test drives: push events, then end it. */
function stream() {
  let push: (e: SessionEvent) => void = () => {};
  let end: () => void = () => {};
  const events: Api['events'] = (onEvent, _signal, onOpen) =>
    new Promise<void>((resolve) => {
      push = onEvent;
      end = resolve;
      onOpen?.();
    });
  return { events, push: (e: SessionEvent) => act(async () => push(e)), end: () => act(async () => end()) };
}

const session = {
  contract: 'CARUWV662HKMXUDX6NS2AHVDXTCO2CRXCJYHWBLU4UAIUGFQLGLGHCQC',
  network: { name: 'testnet' },
  fork: { id: 'f', ledger: 100, time: '', consistent: false, drifted_entries: 0 },
  lane: 29,
  crate: { name: 'counter', manifest: '' },
  build: 'b',
  config: { file: '', calls: 2, overrides: 0, ui_overrides: 0 },
};
let latest: unknown = cycle1;
const s = stream();
const fake: Api = {
  get: vi.fn(async (path: string) => (path === 'session' ? session : latest)) as Api['get'],
  post: vi.fn() as Api['post'],
  del: vi.fn(),
  events: (...args) => s.events(...args),
};

vi.mock('./api.ts', async (original) => ({
  ...(await original<typeof import('./api.ts')>()),
  createApi: () => fake,
}));

beforeEach(() => {
  window.location.hash = '#t=kq3Zp0X8wQ1m5Ytv7Hc2LnR4sJd9BfE6uA-bC_xYz12';
});
afterEach(() => {
  sessionStorage.clear();
});

test('a new cycle replaces the shown one in place, keeping the open call; a failed build keeps it under a banner; a drop reconnects', async () => {
  const { App } = await import('./App.tsx');
  render(<App />);
  expect(await screen.findByText('live')).toBeInTheDocument();
  const list = await screen.findByRole('listbox', { name: 'Calls in this cycle' });
  await userEvent.click(within(list).getByRole('option', { name: /increment/ }));
  expect(within(list).getByRole('option', { name: /increment/ })).toHaveAttribute('aria-selected', 'true');

  // A save: the next cycle is announced and fetched without a reload.
  latest = { ...cycle1, id: 2 };
  await s.push({ type: 'cycle.completed', data: { id: 2 } });
  expect(await screen.findByText(/^#2/)).toBeInTheDocument();
  expect(within(screen.getByRole('listbox', { name: 'Calls in this cycle' })).getByRole('option', { name: /increment/ })).toHaveAttribute('aria-selected', 'true');

  // A save that does not compile: the error, and the last results still there.
  await s.push({ type: 'build.failed', data: { message: 'error[E0308]: mismatched types\n --> src/lib.rs:12:5' } });
  const banner = screen.getByRole('alert');
  expect(banner).toHaveTextContent('The build failed.');
  expect(banner).toHaveTextContent('Running the previous build');
  expect(banner).toHaveTextContent('error[E0308]: mismatched types');
  expect(screen.getByText(/^#2/)).toBeInTheDocument();
  await userEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();

  // signet dev drops the stream: the tab says it is reconnecting.
  await s.end();
  expect(await screen.findByText('reconnecting…')).toBeInTheDocument();
});
