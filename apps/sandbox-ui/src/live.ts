/**
 * @file The session's live state (#585): what `/api/events` says, kept
 * across reconnects. A save in the editor updates the open tab: a new
 * cycle is fetched, a failed build shows its error while the previous
 * build's results stay, drift is announced, and a dropped stream is
 * reconnected with backoff until the session is plainly gone.
 */

import type { Api, SessionEvent } from './api.ts';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface LiveState {
  readonly connection: Connection;
  /** The latest cycle the stream announced. */
  readonly cycleId: number | null;
  /** The compiler's error while the build is broken; the previous build still runs. */
  readonly buildError: string | null;
  /** Entries that drifted on-chain since the fork, when last announced. */
  readonly drift: number | null;
  /** Events, newest first, for the side panel. */
  readonly events: readonly SessionEvent[];
}

export const initialLive: LiveState = { connection: 'connecting', cycleId: null, buildError: null, drift: null, events: [] };

export type LiveAction =
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'connection'; connection: Connection }
  | { kind: 'dismiss'; what: 'buildError' | 'drift' };

export function reduceLive(state: LiveState, action: LiveAction): LiveState {
  switch (action.kind) {
    case 'connection':
      return { ...state, connection: action.connection };
    case 'dismiss':
      return { ...state, [action.what]: null };
    case 'event': {
      const e = action.event;
      const events = [e, ...state.events].slice(0, 40);
      switch (e.type) {
        case 'cycle.completed': {
          const id = typeof e.data?.id === 'number' ? e.data.id : state.cycleId;
          // A cycle runs only after a build that compiled: the error is over.
          return { ...state, events, cycleId: id, buildError: null };
        }
        case 'build.failed':
          return { ...state, events, buildError: typeof e.data?.message === 'string' ? e.data.message : 'the build failed' };
        case 'drift':
          return { ...state, events, drift: typeof e.data?.count === 'number' ? e.data.count : 0 };
        default:
          return { ...state, events };
      }
    }
  }
}

/** The wait before reconnect attempt `n` (1-based): 0.5 s doubling to 8 s. */
export function backoff(n: number): number {
  return Math.min(8000, 500 * 2 ** (n - 1));
}

/** Failed reconnects before the session is taken to have ended. */
export const MAX_RECONNECTS = 5;

/**
 * Follows the event stream, reconnecting with backoff when it drops.
 * Resolves when `signal` aborts or after `MAX_RECONNECTS` failures in a
 * row (the CLI has exited).
 */
export async function follow(
  api: Api,
  dispatch: (a: LiveAction) => void,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  let failures = 0;
  for (;;) {
    dispatch({ kind: 'connection', connection: failures === 0 ? 'connecting' : 'reconnecting' });
    try {
      await api.events(
        (event) => dispatch({ kind: 'event', event }),
        signal,
        () => {
          failures = 0;
          dispatch({ kind: 'connection', connection: 'live' });
        },
      );
    } catch {
      // a refused connection or a broken stream: retried below
    }
    if (signal.aborted) return;
    failures++;
    if (failures > MAX_RECONNECTS) {
      dispatch({ kind: 'connection', connection: 'ended' });
      return;
    }
    dispatch({ kind: 'connection', connection: 'reconnecting' });
    await sleep(backoff(failures));
    if (signal.aborted) return;
  }
}
