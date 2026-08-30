/**
 * The bounded wait that sits at the heart of `signet link`.
 *
 * The whole point of this file is the issue it fixes: a wait that hangs with a
 * blank terminal reads as broken. So it does two things that a naive
 * `while (!approved) poll()` does not:
 *
 *   1. It prints *what* it is waiting for (pairing code + verification URL)
 *      up front, and calls a `report` hook on every poll so the caller can keep
 *      the terminal live instead of silent.
 *   2. It stops after a bounded deadline — the pairing code's own TTL — so it
 *      can never hang indefinitely. On timeout it returns `{ outcome: 'timeout' }`
 *      which the caller maps to retry instructions (including the manual URL).
 *
 * Everything is injectable (`getStatus`, `sleep`, `now`, `report`) so the loop
 * is testable with a fake clock and no real waits or network.
 */

/** The statuses a server can report for a pending pairing. */
export type PollState = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * How the wait ended. `approved`/`rejected`/`expired` are answers from the
 * server; `timeout` means the CLI reached the pairing code's TTL with no
 * answer — precisely the case the issue cares about.
 */
export type WaitOutcome = 'approved' | 'rejected' | 'expired' | 'timeout';

export interface WaitOptions {
  /**
   * How long to wait, i.e. the pairing code's own TTL. The loop's deadline is
   * derived from this, so the CLI never polls past the code's usefulness.
   */
  ttlMs: number;
  /** How long to sleep between polls. */
  pollIntervalMs: number;
  /** Ask the server for the current state; `pending` keeps waiting. */
  getStatus: () => Promise<PollState>;
  /** Sleep helper. Tests inject a fake that advances an imaginary clock. */
  sleep: (ms: number) => Promise<void>;
  /** Current time; tests inject a fake clock matching their fake `sleep`. */
  now: () => number;
  /**
   * Progress feedback, called once before the first poll and after every
   * `pending` poll, with the milliseconds remaining on the pair. The caller
   * uses this to keep the terminal live (countdown / "still waiting").
   */
  report: (info: { remainingMs: number }) => void;
}

export type WaitResult = { outcome: WaitOutcome };

/**
 * Poll for browser approval until an answer arrives or the pairing expires.
 *
 * Never rejects: network/timeout handling lives in the caller's `getStatus`,
 * which is expected to translate failures into a terminal state.
 */
export async function waitForApproval(options: WaitOptions): Promise<WaitResult> {
  const { ttlMs, pollIntervalMs } = options;
  const deadline = options.now() + ttlMs;

  // Tell the user what we are waiting for before we wait.
  options.report({ remainingMs: ttlMs });

  for (;;) {
    // A short first sleep lets the "waiting" banner land before the first poll.
    await options.sleep(pollIntervalMs);

    const state = await options.getStatus();
    if (state !== 'pending') {
      return { outcome: state };
    }

    const remainingMs = deadline - options.now();
    if (remainingMs <= 0) {
      return { outcome: 'timeout' };
    }
    options.report({ remainingMs });
  }
}