// Terminal-linking (device authorization) defaults, shared so the pairing
// code's lifecycle and the CLI wait can never drift apart.
//
// `signet link` (packages/cli) prints a pairing code and a verification URL,
// then polls until the developer approves in the browser. The CLI's wait
// must not outlive the pairing code it printed:
//
//   • LINK_PAIR_TTL_MS — how long a pairing code stays valid. The server
//     creating a pair expires it here, and `signet link` times out on the same
//     deadline, so the CLI never keeps polling after the code has become
//     unapprovable.
//   • LINK_POLL_INTERVAL_MS — how often `signet link` asks the server whether
//     the browser approved. Used by the CLI only.

/** How long a `signet link` pairing code remains valid, and how long the CLI waits. */
export const LINK_PAIR_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** How often `signet link` polls for browser approval while waiting. */
export const LINK_POLL_INTERVAL_MS = 2_000; // 2 seconds