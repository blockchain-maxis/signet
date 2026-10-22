'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { WALLETS_REFRESH_INTERVAL_MS, shouldRefreshWallets } from '@/lib/wallets-refresh';

/**
 * Keeps the server-rendered wallets list fresh while a wallet is still being
 * indexed (#607), so the "indexing…" badge clears on its own.
 *
 * Renders nothing. While `pending` is true it re-fetches the route every
 * `WALLETS_REFRESH_INTERVAL_MS`; the new server render flips `pending` to false
 * once nothing is waiting, which tears the timer down. It also stops after
 * `WALLETS_REFRESH_MAX_MS`, and skips a tick while the tab is in the
 * background, so an idle tab neither polls nor keeps hammering a stuck indexer.
 */
export function WalletsAutoRefresh({ pending }: { pending: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!shouldRefreshWallets(true, Date.now() - startedAt)) {
        clearInterval(timer);
        return;
      }
      if (document.visibilityState === 'hidden') return;
      router.refresh();
    }, WALLETS_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending, router]);

  return null;
}
