'use client';

import { useState, useCallback, useEffect } from 'react';
import type { Operation } from '@/lib/profiles';
import { stellarExpertTxUrl } from '@/lib/network';
import { formatDate } from '@/lib/format-date';

function resolveFunction(op: Operation): string {
  if (op.decoded_function && op.decoded_function !== '?') return op.decoded_function;
  if (op.function && !op.function.startsWith('HostFunction')) return op.function;
  return 'invoke_contract';
}

interface OperationsListProps {
  handle: string;
  initialOperations: Operation[];
  total: number;
  /**
   * True when `total` is a cap rather than the developer's whole history. The
   * end of the list then means "end of what we hold", not "end of the record",
   * and says so instead of reading as a complete timeline.
   */
  truncated?: boolean;
  /** The cap behind `truncated`, named in the end-of-list notice. */
  cap?: number | null;
  /**
   * Endpoint URL to fetch more operations from. Defaults to
   * `/api/p/${encodeURIComponent(handle)}/operations`.
   */
  endpoint?: string;
  /**
   * Custom empty state component when `operations.length === 0`.
   * When omitted, renders the default profile empty state.
   */
  emptyState?: React.ReactNode;
}

export default function OperationsList({
  handle,
  initialOperations,
  total,
  truncated = false,
  cap = null,
  endpoint,
  emptyState,
}: OperationsListProps) {
  const [operations, setOperations] = useState<Operation[]>(initialOperations);
  const [offset, setOffset] = useState(initialOperations.length);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(offset < total);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOperations(initialOperations);
    setOffset(initialOperations.length);
    setHasMore(initialOperations.length < total);
  }, [initialOperations, total, endpoint]);

  const loadMore = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = endpoint ?? `/api/p/${encodeURIComponent(handle)}/operations`;
      const sep = base.includes('?') ? '&' : '?';
      const res = await fetch(`${base}${sep}offset=${offset}&limit=25`);
      if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
      const json = await res.json();
      setOperations((prev) => [...prev, ...json.data]);
      setOffset((prev) => prev + json.data.length);
      setHasMore(json.meta.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more operations');
    } finally {
      setLoading(false);
    }
  }, [handle, offset, endpoint]);

  return (
    <div className="mt-6 border border-[#1f1d19]">
      {/* Header */}
      <div
        className="flex items-center justify-between gap-4 border-b border-[#1f1d19] px-5 py-3 text-[9px] uppercase tracking-[0.22em] text-[var(--text-muted)] md:grid md:grid-cols-[1fr_auto_auto]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <span>Function</span>
        <span className="hidden md:block">Date</span>
        <span>Tx</span>
      </div>

      {operations.length === 0 ? (
        emptyState ?? (
          <div className="bg-[#0e0d0b] px-5 py-6">
            <p
              className="text-[13px] leading-[1.7] text-[#b8b5a8]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              No Soroban invocations are recorded for this profile yet.
            </p>
            <p
              className="mt-2 text-[12px] leading-[1.6] text-[var(--text-muted)]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              The wallet that claimed this handle is rarely the key used with{' '}
              <code className="text-[#8a8779]">stellar contract deploy</code>. Link your deploy wallet from the CLI to attribute its contract activity:
            </p>
            <code
              className="mt-4 block max-w-full overflow-x-auto bg-[#0a0908] px-4 py-2.5 text-[12px] text-[#f5f4ee] border border-[#1f1d19]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              npx @signet/cli link
            </code>
          </div>
        )
      ) : (
        <>
          {operations.map((op, i) => {
            const fn = resolveFunction(op);
            const balChanges = op.asset_balance_changes ?? [];
            return (
              <div
                key={op.id}
                data-testid="operation-row"
                className={`group flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-[#0e0d0b] md:grid md:grid-cols-[1fr_auto_auto] md:items-start ${
                  i < operations.length - 1 ? 'border-b border-[#1f1d19]' : ''
                }`}
              >
                <div className="min-w-0">
                  <span
                    className="block break-words [overflow-wrap:anywhere] font-medium text-[13px] text-[#b8b5a8]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {fn}
                  </span>
                  {balChanges.length > 0 && (
                    <span
                      className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {balChanges.map((bc, j) => (
                        <span key={j}>
                          {bc.type === 'transfer' ? '↔' : '·'}{' '}
                          {bc.amount} {bc.asset_code ?? 'XLM'}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <span
                  className="text-[11px] text-[var(--text-muted)] whitespace-nowrap"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {formatDate(op.created_at)}
                </span>
                {op.transaction_hash ? (
                  <a
                    href={stellarExpertTxUrl(op.transaction_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="whitespace-nowrap text-[10px] uppercase tracking-[0.18em] text-[var(--text-accent)] transition-colors hover:text-[var(--text-accent)]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    Verify ↗
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="text-[10px] text-[var(--text-faint)]" style={{ fontFamily: 'var(--font-mono)' }}>—</span>
                )}
              </div>
            );
          })}

          {/* Load More */}
          {hasMore && (
            <div className="border-t border-[#1f1d19] px-5 py-4 text-center">
              {error && (
                <p className="mb-2 text-[11px] text-red-400" style={{ fontFamily: 'var(--font-mono)' }}>
                  {error}
                </p>
              )}
              <button
                onClick={loadMore}
                disabled={loading}
                className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-[var(--text-accent)] transition-colors hover:text-[var(--text-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {loading ? (
                  <>
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border border-[#8b1a1a] border-t-transparent" />
                    Loading…
                  </>
                ) : (
                  <>
                    Load more
                    <span>↓</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* End of what we hold — never the end of the record when capped. */}
          {truncated && !hasMore && (
            <div className="border-t border-[#1f1d19] bg-[#0e0d0b] px-5 py-4">
              <p
                className="text-[11px] leading-[1.7] text-amber-300/90"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                End of the {total} operations retrieved
                {cap ? ` (capped at the ${cap} most recent)` : ''} — this account has older
                invocations that are not shown here.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
