'use client';

import { useState, useCallback } from 'react';
import type { Operation } from '@/lib/profiles';

function truncate(str: string, head: number, tail: number): string {
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function resolveFunction(op: Operation): string {
  if (op.decoded_function && op.decoded_function !== '?') return op.decoded_function;
  if (op.function && !op.function.startsWith('HostFunction')) return op.function;
  return 'invoke_contract';
}

// Demo profiles use synthetic data on Stellar testnet.
const NETWORK = 'testnet';

function stellarExpertTx(hash: string): string {
  return `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`;
}

interface OperationsListProps {
  handle: string;
  initialOperations: Operation[];
  total: number;
}

export default function OperationsList({ handle, initialOperations, total }: OperationsListProps) {
  const [operations, setOperations] = useState<Operation[]>(initialOperations);
  const [offset, setOffset] = useState(initialOperations.length);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(offset < total);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/p/${encodeURIComponent(handle)}/operations?offset=${offset}&limit=25`);
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
  }, [handle, offset]);

  return (
    <div className="mt-6 border border-[#1f1d19]">
      {/* Header */}
      <div
        className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-[#1f1d19] px-5 py-3 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <span>Function</span>
        <span className="hidden md:block">Date</span>
        <span>Tx</span>
      </div>

      {operations.length === 0 ? (
        <div className="bg-[#0e0d0b] px-5 py-6">
          <p
            className="text-[13px] leading-[1.7] text-[#b8b5a8]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            This profile has not been indexed yet, so there are no Soroban invocations to display.
          </p>
          <p
            className="mt-2 text-[12px] leading-[1.6] text-[#5e5b51]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Once the wallet starts interacting with contracts, the activity timeline and stats will
            populate here.
          </p>
        </div>
      ) : (
        <>
          {operations.map((op, i) => {
            const fn = resolveFunction(op);
            const balChanges = op.asset_balance_changes ?? [];
            return (
              <div
                key={op.id}
                className={`group grid grid-cols-[1fr_auto_auto] items-start gap-4 px-5 py-4 transition-colors hover:bg-[#0e0d0b] ${
                  i < operations.length - 1 ? 'border-b border-[#1f1d19]' : ''
                }`}
              >
                <div className="min-w-0">
                  <span
                    className="block font-medium text-[13px] text-[#b8b5a8]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {fn}
                  </span>
                  {balChanges.length > 0 && (
                    <span
                      className="block text-[11px] text-[#5e5b51] mt-1"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {balChanges.map((bc, j) => (
                        <span key={j} className="mr-3">
                          {bc.type === 'transfer' ? '↔' : '·'}{' '}
                          {bc.amount} {bc.asset_code ?? 'XLM'}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <span
                  className="hidden text-[11px] text-[#5e5b51] md:block whitespace-nowrap"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {fmtDate(op.created_at)}
                </span>
                {op.transaction_hash ? (
                  <a
                    href={stellarExpertTx(op.transaction_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="whitespace-nowrap text-[10px] uppercase tracking-[0.18em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    Verify ↗
                  </a>
                ) : (
                  <span className="text-[10px] text-[#3d3a33]" style={{ fontFamily: 'var(--font-mono)' }}>—</span>
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
                className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-colors hover:text-[#c2410c] disabled:opacity-40 disabled:cursor-not-allowed"
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
        </>
      )}
    </div>
  );
}
