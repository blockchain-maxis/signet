import { describe, expect, test, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SpecJson } from '@signet/spec';
import { ApiError, type Api } from '../api.ts';
import { CallForm, __resetClassification } from './CallForm.tsx';
import registry from '../fixtures/identity-registry.spec.json';
import zoo from '../fixtures/types-zoo.spec.json';

const WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function fakeApi(post: Api['post'] = async () => ({ outcome: 'result', modifiedEntries: [] }) as never) {
  const spy = vi.fn(post);
  const api: Api = { get: vi.fn(), post: spy as Api['post'], del: vi.fn(), events: vi.fn() };
  return { api, post: spy };
}

/** The bodies posted for `fn`, leaving out the dry runs of argument-less functions. */
const callsTo = (post: ReturnType<typeof vi.fn>, fn: string) =>
  post.mock.calls.filter(([, body]) => (body as { function: string }).function === fn).map(([, body]) => body);

async function open(fn: string, spec: SpecJson, api: Api) {
  cleanup();
  render(<CallForm api={api} specs={{ deployed: spec, local: null }} />);
  // Let the dry runs of argument-less functions settle the picker's groups.
  await act(async () => {});
  await userEvent.click(within(screen.getByRole('navigation', { name: 'Functions' })).getByRole('button', { name: fn }));
  return screen.getByRole('form', { name: `Call ${fn}` });
}

beforeEach(() => __resetClassification());

describe("the registry's claim", () => {
  test('a bad wallet shows a field error and posts nothing', async () => {
    const { api, post } = fakeApi();
    const form = await open('claim', registry as SpecJson, api);
    await userEvent.type(within(form).getByLabelText(/^handle/), 'alice');
    await userEvent.type(within(form).getByLabelText(/^wallet/), 'not-an-address');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('wallet: expected an account (G…) or contract (C…) address');
    expect(within(form).getByLabelText(/^wallet/)).toHaveAttribute('aria-invalid', 'true');
    expect(callsTo(post, 'claim')).toEqual([]);
  });

  test('a valid submit posts the arguments as the simulator encodes them', async () => {
    const { api, post } = fakeApi();
    const form = await open('claim', registry as SpecJson, api);
    await userEvent.type(within(form).getByLabelText(/^handle/), 'alice');
    await userEvent.type(within(form).getByLabelText(/^wallet/), WALLET);
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'claim')).toEqual([
      { function: 'claim', args: { handle: 'alice', wallet: WALLET }, auth_mode: 'record', wasm: 'deployed' },
    ]);
  });

  test("a server error naming a field is shown on that field (#545's path)", async () => {
    const { api } = fakeApi(async (_path, body) => {
      if ((body as { function: string }).function === 'claim') {
        throw new ApiError(400, 'bad_request: wallet: expected Address (G… or C…), got number');
      }
      return { outcome: 'result', modifiedEntries: [] } as never;
    });
    const form = await open('claim', registry as SpecJson, api);
    await userEvent.type(within(form).getByLabelText(/^handle/), 'alice');
    await userEvent.type(within(form).getByLabelText(/^wallet/), WALLET);
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('wallet: expected Address (G… or C…), got number');
  });
});

test("the registry's resolve_batch takes a list, row by row", async () => {
  const { api, post } = fakeApi();
  const form = await open('resolve_batch', registry as SpecJson, api);
  await userEvent.click(within(form).getByRole('button', { name: 'Add item' }));
  await userEvent.click(within(form).getByRole('button', { name: 'Add item' }));
  await userEvent.type(within(form).getByLabelText(/^handles\[0\]/), 'alice');
  await userEvent.type(within(form).getByLabelText(/^handles\[1\]/), 'bob');
  await userEvent.click(within(form).getByRole('button', { name: 'remove item 1 of handles' }));
  await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
  expect(callsTo(post, 'resolve_batch')).toEqual([
    { function: 'resolve_batch', args: { handles: ['bob'] }, auth_mode: 'record', wasm: 'deployed' },
  ]);
});

test('argument-less functions are dry-run once and grouped as read or write', async () => {
  const { api } = fakeApi(async (_path, body) =>
    ({ outcome: 'result', modifiedEntries: (body as { function: string }).function === 'count' ? [] : [{}] }) as never,
  );
  render(<CallForm api={api} specs={{ deployed: registry as SpecJson, local: null }} />);
  const nav = screen.getByRole('navigation', { name: 'Functions' });
  expect(await within(nav).findByRole('heading', { name: 'Read' })).toBeInTheDocument();
  const read = within(nav).getByRole('heading', { name: 'Read' }).parentElement!;
  expect(within(read).getByRole('button', { name: 'count' })).toBeInTheDocument();
  expect(within(within(nav).getByRole('heading', { name: 'Not run yet' }).parentElement!).getByRole('button', { name: 'claim' })).toBeInTheDocument();
});

describe('every fixture type gets a widget and encodes as the schema says', () => {
  const zooSpec = zoo as SpecJson;

  test.each(zooSpec.functions.filter((f) => !f.isConstructor).map((f) => f.name))('%s renders a field per argument', async (fn) => {
    const { api } = fakeApi();
    const form = await open(fn, zooSpec, api);
    const inputs = zooSpec.functions.find((f) => f.name === fn)!.inputs;
    for (const input of inputs) {
      expect(within(form).getAllByText(input.name, { exact: true }).length).toBeGreaterThan(0);
    }
  });

  test('integers are range-checked and wide ones sent as strings', async () => {
    const { api, post } = fakeApi();
    const form = await open('ints', zooSpec, api);
    const values: Record<string, string> = { a: '7', b: '-7', c: '18446744073709551615', d: '-1', e: '1', f: '-170141183460469231731687303715884105728', g: '0', h: '1' };
    for (const [name, v] of Object.entries(values)) await userEvent.type(within(form).getByLabelText(new RegExp(`^${name}\\b`)), v);
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'ints')[0]).toMatchObject({ args: { a: 7, b: -7, c: '18446744073709551615', f: '-170141183460469231731687303715884105728' } });

    await userEvent.clear(within(form).getByLabelText(/^a\b/));
    await userEvent.type(within(form).getByLabelText(/^a\b/), '4294967296');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('a: out of range for u32');
  });

  test('bytes are hex with their length; a BytesN of the wrong length is an error', async () => {
    const { api, post } = fakeApi();
    const form = await open('blobs', zooSpec, api);
    await userEvent.type(within(form).getByLabelText(/^s\b/), 'hello');
    await userEvent.type(within(form).getByLabelText(/^sym\b/), 'hi');
    await userEvent.type(within(form).getByLabelText(/^b\b/), '0xdead');
    await userEvent.type(within(form).getByLabelText(/^fixed\b/), 'ab');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/fixed: expected \d+ bytes, got 1/);
    expect(callsTo(post, 'blobs')).toEqual([]);
    await userEvent.clear(within(form).getByLabelText(/^fixed\b/));
    await userEvent.type(within(form).getByLabelText(/^fixed\b/), 'ab'.repeat(32));
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'blobs')[0]).toMatchObject({ args: { s: 'hello', sym: 'hi', b: '3q0=' } });
  });

  test('an Option left at none is left out; given, it is sent', async () => {
    const { api, post } = fakeApi();
    const form = await open('maybe', zooSpec, api);
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'maybe')[0]).toMatchObject({ args: {} });
    await userEvent.click(within(form).getByRole('checkbox', { name: /give v a value/ }));
    await userEvent.type(within(form).getByLabelText(/^v\b/), '3');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'maybe')[1]).toMatchObject({ args: { v: 3 } });
  });

  test('enums, unions, maps, tuples and nested structs encode in the schema shape', async () => {
    const { api, post } = fakeApi();
    let form = await open('paint', zooSpec, api);
    await userEvent.selectOptions(within(form).getByLabelText(/^c\b/), 'Green (2)');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'paint')[0]).toMatchObject({ args: { c: 2 } });

    form = await open('shape', zooSpec, api);
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 's variant' }), 'Point');
    await userEvent.type(within(form).getByLabelText(/^Point\.0/), '1');
    await userEvent.type(within(form).getByLabelText(/^Point\.1/), '2');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'shape')[0]).toMatchObject({ args: { s: { tag: 'Point', values: [1, 2] } } });

    form = await open('lookup', zooSpec, api);
    await userEvent.click(within(form).getByRole('button', { name: 'Add entry' }));
    await userEvent.type(within(form).getByLabelText(/^key 1/), 'k');
    await userEvent.type(within(form).getByLabelText(/^value 1/), '9');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'lookup')[0]).toMatchObject({ args: { m: [['k', 9]] } });

    form = await open('pair', zooSpec, api);
    await userEvent.type(within(form).getByLabelText(/^p\.0/), '4');
    await userEvent.type(within(form).getByLabelText(/^p\.1/), 'x');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'pair')[0]).toMatchObject({ args: { p: [4, 'x'] } });

    form = await open('nested', zooSpec, api);
    await userEvent.type(within(form).getByLabelText(/^value\b/), '5');
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));
    expect(callsTo(post, 'nested')[0]).toMatchObject({ args: { v: { inner: { inner: { value: 5 } } } } });
  });
});

test('run on both posts the call to the deployed code and to the build', async () => {
  const { api, post } = fakeApi();
  render(<CallForm api={api} specs={{ deployed: registry as SpecJson, local: registry as SpecJson }} />);
  await userEvent.click(screen.getByRole('radio', { name: 'both' }));
  await userEvent.click(within(screen.getByRole('navigation', { name: 'Functions' })).getByRole('button', { name: 'resolve' }));
  const form = screen.getByRole('form', { name: 'Call resolve' });
  await userEvent.type(within(form).getByLabelText(/^handle/), 'alice');
  await userEvent.click(within(form).getByRole('button', { name: 'Run on both' }));
  expect(callsTo(post, 'resolve').map((b) => (b as { wasm: string }).wasm)).toEqual(['deployed', 'local']);
});
