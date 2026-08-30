// Public surface of @signet/cli.
//
// Most consumers never import this package — they run the `signet` binary.
// The exports below exist so the wait loop, the HTTP client, and the command
// orchestration are individually testable and reusable.

export { LinkClient, SignetLinkError } from './link-client.ts';
export type { DevicePair, LinkState, LinkStatus } from './link-client.ts';
export { waitForApproval } from './wait-for-approval.ts';
export type { PollState, WaitOptions, WaitOutcome, WaitResult } from './wait-for-approval.ts';
export { linkCommand, formatRemaining, formatTtlLabel } from './link.ts';
export type { LinkCommandDeps } from './link.ts';
export { run } from './cli.ts';