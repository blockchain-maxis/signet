import { describe, expect, test, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SpecJson } from '@signet/spec';
import { ApiError, type Api } from '../api.ts';
import { CallView } from './CallView.tsx';
import { __resetClassification } from './CallForm.tsx';
import registry from '../fixtures/identity-registry.spec.json';

const WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function setupApi(
  postHandler?: (path: string, body: unknown) => Promise<unknown>,
) {
  const postSpy = vi.fn(
    postHandler ??
      (async (path: string) => {
        if (path === 'call') {
          return { outcome: 'result', modifiedEntries: [] };
        }
        if (path === 'calls') {
          return { saved: true };
        }
        return {};
      }),
  );

  const getSpy = vi.fn(async (path: string) => {
    if (path.startsWith('spec?wasm=deployed')) {
      return registry as SpecJson;
    }
    if (path.startsWith('spec?wasm=local')) {
      return null;
    }
    if (path.startsWith('state?layer=fork')) {
      return { entries: [] };
    }
    return {};
  });

  const api: Api = {
    get: getSpy as Api['get'],
    post: postSpy as Api['post'],
    del: vi.fn(),
    events: vi.fn(),
  };

  return { api, post: postSpy, get: getSpy };
}

beforeEach(() => {
  cleanup();
  __resetClassification();
});

describe('CallView - save as replay', () => {
  test('after a successful run, saving posts calls with function, args, name, and expect', async () => {
    const { api, post } = setupApi();
    render(<CallView api={api} refresh={0} />);

    // Wait for spec and initial dry-runs to settle
    await act(async () => {});

    // Open 'claim' form
    const nav = screen.getByRole('navigation', { name: 'Functions' });
    await userEvent.click(within(nav).getByRole('button', { name: 'claim' }));

    const form = screen.getByRole('form', { name: 'Call claim' });
    await userEvent.type(within(form).getByLabelText(/^handle/), 'alice');
    await userEvent.type(within(form).getByLabelText(/^wallet/), WALLET);
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));

    // Result panel should appear
    expect(await screen.findByRole('article', { name: /^Read: claim/ })).toBeInTheDocument();

    // Save as replay form should be rendered
    const saveForm = screen.getByRole('form', { name: 'Save as a replay' });
    expect(saveForm).toBeInTheDocument();

    // Default name is function name
    const nameInput = within(saveForm).getByLabelText('Name');
    expect(nameInput).toHaveValue('claim');

    // Expect select has unchanged as default, plus ok, any, and error cases from registry spec
    const expectSelect = within(saveForm).getByLabelText('Expect');
    expect(expectSelect).toHaveValue('unchanged');

    // Options should include unchanged, ok, any, and error:<Name> from registry errors
    const options = within(expectSelect).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('unchanged');
    expect(options).toContain('ok');
    expect(options).toContain('any');
    expect(options).toContain('error:HandleTaken');
    expect(options).toContain('error:InvalidHandle');

    // Customize name and expect
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'my-claim-replay');
    await userEvent.selectOptions(expectSelect, 'ok');

    // Submit save form
    await userEvent.click(within(saveForm).getByRole('button', { name: 'Save as a replay' }));

    // Check post was called with exact args
    const saveCalls = post.mock.calls.filter(([path]) => path === 'calls');
    expect(saveCalls).toHaveLength(1);
    const firstCall = saveCalls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![1]).toEqual({
      name: 'my-claim-replay',
      function: 'claim',
      args: { handle: 'alice', wallet: WALLET },
      expect: 'ok',
    });

    // Confirmation message shown with status role and focused
    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('Saved call to signet.dev.toml');
    expect(confirmation).toHaveFocus();
  });

  test('a 400 from server shows error message and moves focus to it', async () => {
    const { api } = setupApi(async (path: string) => {
      if (path === 'call') {
        return { outcome: 'result', modifiedEntries: [] };
      }
      if (path === 'calls') {
        throw new ApiError(400, 'there is no signet.dev.toml to save to');
      }
      return {};
    });

    render(<CallView api={api} refresh={0} />);
    await act(async () => {});

    const nav = screen.getByRole('navigation', { name: 'Functions' });
    await userEvent.click(within(nav).getByRole('button', { name: 'count' }));

    const form = screen.getByRole('form', { name: 'Call count' });
    await userEvent.click(within(form).getByRole('button', { name: 'Run' }));

    expect(await screen.findByRole('article', { name: /^Read: count/ })).toBeInTheDocument();

    const saveForm = screen.getByRole('form', { name: 'Save as a replay' });
    await userEvent.click(within(saveForm).getByRole('button', { name: 'Save as a replay' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('there is no signet.dev.toml to save to');
    expect(alert).toHaveFocus();
  });
});
