'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * One shared polite live region for the whole contract page (#461).
 *
 * Every copy button announces through this single region instead of mounting
 * its own: a region that appears in the DOM at the same moment as its text is
 * frequently missed by screen readers, and several regions on one page makes
 * the announcements race each other. The region is rendered once, empty, and
 * only its text changes.
 */
type Announce = (message: string) => void;

const AnnounceContext = createContext<Announce>(() => {});

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

export function AnnounceProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState('');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const announce = useCallback<Announce>((next) => {
    timers.current.forEach(clearTimeout);
    // Clear first so announcing the same text twice (two copies in a row)
    // still counts as a change and is read again.
    setMessage('');
    timers.current = [
      setTimeout(() => setMessage(next), 50),
      setTimeout(() => setMessage(''), 3000),
    ];
  }, []);

  const value = useMemo(() => announce, [announce]);

  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}
