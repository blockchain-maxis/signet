'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { AccountApiKey } from '@/lib/server/account-api-keys';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/** `2026-10-26T…` → `2026-10-26`. */
const day = (iso: string) => iso.slice(0, 10);

/**
 * Create, list and revoke the account's API keys (#652).
 *
 * A new key is shown once, in a modal dialog: a native `<dialog>` opened with
 * `showModal()`, so the rest of the page is inert and focus stays inside it,
 * and focus goes back to the Create button when it closes. After that only
 * the key's prefix is ever shown.
 */
export function ApiKeysManager({ max }: { max: number }) {
  const utils = trpc.useUtils();
  const keys = trpc.account.apiKeys.list.useQuery();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);

  const create = trpc.account.apiKeys.create.useMutation({
    onSuccess: ({ key }) => {
      setName('');
      setCreated(key);
      void utils.account.apiKeys.list.invalidate();
    },
  });

  const closeDialog = useCallback(() => {
    setCreated(null);
    createButton.current?.focus();
  }, []);

  const count = keys.data?.length ?? 0;

  return (
    <div className="mt-10 max-w-[760px]">
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name });
        }}
      >
        <label className="grid gap-2 text-[13px] text-[#b8b5a8]">
          Key name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            required
            autoComplete="off"
            placeholder="grant-portal production"
            aria-describedby="api-key-name-help api-key-create-error"
            className="border border-[#2e2c27] bg-[#0e0d0b] px-3 py-2.5 text-[14px] text-[#f5f4ee] placeholder:text-[#8a8779] focus-visible:border-[var(--text-accent)] focus-visible:outline-none"
            style={mono}
          />
        </label>
        <button
          ref={createButton}
          type="submit"
          disabled={create.isPending}
          className="border border-[var(--text-accent)] px-5 py-2.5 text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee] transition-colors hover:bg-[var(--text-accent)] hover:text-[#0a0908] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908] active:translate-y-px disabled:opacity-60"
          style={mono}
        >
          {create.isPending ? 'Creating…' : 'Create key'}
        </button>
        <p id="api-key-name-help" className="text-[12px] text-[#8a8779] sm:col-span-2">
          Name it after where it will be used, so you know which one to revoke.
        </p>
        <p
          id="api-key-create-error"
          role="alert"
          className="text-[13px] text-[var(--text-accent)] sm:col-span-2 empty:hidden"
        >
          {create.error?.message ?? ''}
        </p>
      </form>

      <h2
        className="mt-12 text-[11px] uppercase tracking-[0.26em] text-[var(--text-muted)]"
        style={mono}
      >
        Active keys{keys.data ? ` (${count} of ${max})` : ''}
      </h2>
      <KeyList query={keys} />

      <NewKeyDialog apiKey={created} onClose={closeDialog} />
    </div>
  );
}

interface ListQuery {
  isPending: boolean;
  isError: boolean;
  error: { message: string } | null;
  data: AccountApiKey[] | undefined;
  refetch: () => unknown;
}

function KeyList({ query }: { query: ListQuery }) {
  if (query.isPending) {
    return (
      <ul className="mt-4" aria-busy="true" aria-label="Loading keys">
        {[0, 1].map((i) => (
          <li key={i} className="flex h-[58px] items-center border-t border-[#1f1d19]">
            <span className="h-3 w-48 animate-pulse bg-[#1f1d19] motion-reduce:animate-none" />
          </li>
        ))}
      </ul>
    );
  }
  if (query.isError) {
    return (
      <p className="mt-4 text-[14px] text-[var(--text-accent)]" role="alert">
        Could not load your keys: {query.error?.message}{' '}
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="underline underline-offset-4"
        >
          Try again
        </button>
      </p>
    );
  }
  const keys = query.data ?? [];
  if (keys.length === 0) {
    return (
      <p className="mt-4 text-[14px] leading-[1.7] text-[#8a8779]">
        No keys yet. Create one above; the API works without one at the anonymous limit.
      </p>
    );
  }
  return (
    <ul className="mt-4">
      {keys.map((k) => (
        <li
          key={k.id}
          className="grid gap-2 border-t border-[#1f1d19] py-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_13rem] sm:items-center sm:gap-6"
        >
          <div className="min-w-0">
            <p className="truncate text-[14px] text-[#f5f4ee]">{k.name}</p>
            <p className="mt-1 text-[12px] text-[#8a8779]" style={mono}>
              {k.prefix}…
            </p>
          </div>
          <p className="text-[12px] leading-[1.6] text-[#8a8779]" style={mono}>
            Created {day(k.createdAt)}
            <br />
            {k.lastUsedAt ? `Last used ${day(k.lastUsedAt)}` : 'Never used'}
          </p>
          <div className="sm:justify-self-end">
            <RevokeButton id={k.id} name={k.name} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Two-step revoke, as the wallets page's unlink: Revoke, then Confirm or Cancel. */
function RevokeButton({ id, name }: { id: string; name: string }) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const revoke = trpc.account.apiKeys.revoke.useMutation({
    onSuccess: () => void utils.account.apiKeys.list.invalidate(),
  });
  const btn =
    'text-[10px] uppercase tracking-[0.2em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-accent)]';

  if (revoke.isError) {
    return (
      <span className="text-[12px] text-[var(--text-accent)]" role="alert">
        {revoke.error.message}
      </span>
    );
  }
  if (confirming) {
    return (
      <span className="flex items-center gap-3" style={mono}>
        <span className="text-[10px] uppercase tracking-[0.2em] text-[#8a8779]">Revoke?</span>
        <button
          type="button"
          autoFocus
          onClick={() => revoke.mutate({ id })}
          disabled={revoke.isPending}
          aria-label={`Confirm revoking ${name}`}
          className={`${btn} text-[var(--text-accent)]`}
        >
          {revoke.isPending ? 'Revoking…' : 'Confirm'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className={`${btn} text-[var(--text-muted)] hover:text-[#b8b5a8]`}
        >
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      aria-label={`Revoke ${name}`}
      className={`${btn} text-[var(--text-muted)] hover:text-[var(--text-accent)]`}
      style={mono}
    >
      Revoke
    </button>
  );
}

/** The one time a key is shown in full. */
function NewKeyDialog({ apiKey, onClose }: { apiKey: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (apiKey && !el.open) {
      setCopied(false);
      el.showModal();
    }
    if (!apiKey && el.open) el.close();
  }, [apiKey]);

  const copy = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="new-key-title"
      aria-describedby="new-key-warning"
      onClose={onClose}
      className="m-auto w-[min(92vw,560px)] border border-[#2e2c27] bg-[#0e0d0b] p-0 text-[#f5f4ee] backdrop:bg-[#0a0908]/80"
    >
      <div className="px-6 py-6">
        <h2 id="new-key-title" className="text-[20px] font-bold tracking-[-0.01em]">
          Your new API key
        </h2>
        <p id="new-key-warning" className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Copy it now. You won&apos;t see this key again: Signet stores only a hash of it.
        </p>
        <p
          className="mt-5 break-all border border-[#1f1d19] bg-[#0a0908] px-4 py-3 text-[13px] text-[#f5f4ee]"
          style={mono}
          aria-label="API key"
        >
          {apiKey}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            autoFocus
            onClick={() => void copy()}
            aria-label="Copy API key"
            className="border border-[var(--text-accent)] px-5 py-2.5 text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee] transition-colors hover:bg-[var(--text-accent)] hover:text-[#0a0908] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e0d0b]"
            style={mono}
          >
            {copied ? 'Copied' : 'Copy key'}
          </button>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="text-[11px] uppercase tracking-[0.22em] text-[#8a8779] transition-colors hover:text-[#f5f4ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-accent)]"
            style={mono}
          >
            Done
          </button>
          <span role="status" aria-live="polite" className="sr-only">
            {copied ? 'API key copied to clipboard' : ''}
          </span>
        </div>
      </div>
    </dialog>
  );
}
