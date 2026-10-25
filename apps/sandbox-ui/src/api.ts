/**
 * @file The local API client (#577, #579).
 *
 * The CLI opens http://127.0.0.1:<port>/#t=<token>. The fragment never
 * reaches the server's logs or a Referer; the app reads it once, keeps it
 * for this tab (sessionStorage, so a reload still works), takes it out of
 * the address bar, and sends it as `Authorization: Bearer` on every
 * request. No cookie is ever set, so no other site can ride it.
 */

const STORAGE_KEY = 'signet-dev-token';

/** The token in a URL fragment (`#t=…`, possibly with other params). */
export function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('t');
  return token && /^[A-Za-z0-9_-]{20,}$/.test(token) ? token : null;
}

/** The fragment without the token, for the address bar. */
export function hashWithoutToken(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete('t');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

/** The run's token: from the fragment the CLI opened, or this tab's copy. */
export function takeToken(): string | null {
  const fromHash = tokenFromHash(window.location.hash);
  if (fromHash) {
    try {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
    } catch {
      // storage off: the token lives as long as the page
    }
    const clean =
      window.location.pathname + window.location.search + hashWithoutToken(window.location.hash);
    window.history.replaceState(null, '', clean);
    return fromHash;
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
  events(onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<void>;
}

/** One line of /api/events. */
export interface SessionEvent {
  readonly type: 'build.started' | 'build.failed' | 'cycle.completed' | 'drift' | string;
  readonly data?: Record<string, unknown>;
}

/**
 * Splits streamed NDJSON into whole lines: returns the parsed lines and the
 * unfinished remainder to prepend to the next chunk.
 */
export function splitLines(buffer: string): { lines: unknown[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const lines: unknown[] = [];
  for (const part of parts) {
    if (part.trim() === '') continue;
    try {
      lines.push(JSON.parse(part));
    } catch {
      // a malformed line is skipped, not fatal to the stream
    }
  }
  return { lines, rest };
}

export function createApi(token: string): Api {
  const headers = { Authorization: `Bearer ${token}` };
  async function parse<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
    return body as T;
  }
  return {
    async get<T>(path: string) {
      return parse<T>(await fetch(`/api/${path}`, { headers, cache: 'no-store' }));
    },
    async post<T>(path: string, body: unknown) {
      return parse<T>(
        await fetch(`/api/${path}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
    async del(path: string) {
      const res = await fetch(`/api/${path}`, { method: 'DELETE', headers });
      if (!res.ok) await parse(res);
    },
    // fetch streaming, not EventSource: EventSource cannot send the header.
    async events(onEvent, signal) {
      const res = await fetch('/api/events', { headers, signal });
      if (!res.ok || !res.body)
        throw new ApiError(res.status, `the event stream answered ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const { lines, rest } = splitLines(buffer + value);
        buffer = rest;
        for (const line of lines) onEvent(line as SessionEvent);
      }
    },
  };
}
