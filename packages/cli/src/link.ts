/**
 * The `signet link` command.
 *
 * Wires together the pieces of the wait loop into a command the developer
 * actually runs: ask the server for a pairing code, print clearly what we are
 * waiting for, try to open the approval page in a browser, poll until the pair
 * is answered or expires, and — crucially — on timeout tell the developer how
 * to retry, including the manual URL they can type by hand.
 */

import { spawn } from 'node:child_process';
import { LINK_PAIR_TTL_MS, LINK_POLL_INTERVAL_MS } from '@signet/types';
import { LinkClient, SignetLinkError } from './link-client.ts';
import {
  type PollState,
  type WaitOptions,
  type WaitResult,
  waitForApproval,
} from './wait-for-approval.ts';

export interface LinkCommandDeps {
  /** HTTP client for the link server (inject a mock in tests). */
  client: LinkClient;
  /** Writes a line to the terminal. Defaults to `console.log`. */
  log?: (line: string) => void;
  /** Best-effort browser open; failures are swallowed. Defaults to a real open. */
  openUrl?: (url: string) => void;
  /** The wait loop; default is the real one. Tests inject a deterministic fake. */
  wait?: (options: WaitOptions) => Promise<WaitResult>;
  /** Site name for copy (default "Signet"). */
  siteName?: string;
}

/** Format a millisecond countdown as `m:ss`. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Format an expiry duration as "5 minutes (05:00)". */
export function formatTtlLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'} (${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')})`;
}

export async function linkCommand(options: LinkCommandDeps): Promise<number> {
  const client = options.client;
  const log = options.log ?? console.log.bind(console);
  const openUrl = options.openUrl ?? openBrowser;
  const wait = options.wait ?? waitForApproval;
  const siteName = options.siteName ?? 'Signet';

  let pair;
  try {
    pair = await client.createDevice();
  } catch (err) {
    log(errMessage(err, 'Could not start a linking session'));
    log(`Make sure the link server at ${client.baseUrl} is reachable, then retry:`);
    log(`  signet link --api ${client.baseUrl}`);
    return 1;
  }

  const ttlMs = pair.ttlMs > 0 ? pair.ttlMs : LINK_PAIR_TTL_MS;
  const intervalMs = pair.intervalMs > 0 ? pair.intervalMs : LINK_POLL_INTERVAL_MS;

  // What we are waiting for, said out loud instead of leaving a blank terminal.
  log('');
  log(`${siteName} link — waiting for you to approve in your browser`);
  log(`  Pairing code:  ${pair.pairingCode}`);
  log(`  Approve at:    ${pair.verificationUrl}`);
  log(`  Expires in:    ${formatTtlLabel(ttlMs)}`);
  log('');
  log('If a browser did not open, visit the "Approve at" URL above manually.');
  log('');

  openUrl(pair.verificationUrl);

  let result: WaitResult;
  try {
    result = await wait({
      ttlMs,
      pollIntervalMs: intervalMs,
      getStatus: () => statusOrThrow(client, pair.pairingCode),
      sleep: realSleep,
      now: Date.now,
      report: ({ remainingMs }) => {
        // \x1b[2K clears the line, \r returns to its start — keeps the terminal
        // live during a multi-minute wait without an endless scroll of lines.
        process.stdout.write(
          `\x1b[2K\r⏳ Approval pending… ${formatRemaining(remainingMs)} remaining · ${pair.verificationUrl}`,
        );
      },
    });
    clearStatusLine();
  } catch (err) {
    clearStatusLine();
    log(errMessage(err, 'Could not reach the link server while waiting'));
    log('This is a connection problem, not a hang. Retry once the server is reachable:');
    log(`  signet link --api ${client.baseUrl}`);
    return 1;
  }

  switch (result.outcome) {
    case 'approved':
      log(`✓ Linked! ${siteName} can now reach your machine.`);
      return 0;
    case 'rejected':
      log('✗ The approval was rejected in the browser.');
      log('Run `signet link` again to start over.');
      return 1;
    case 'expired':
      log('');
      log('✗ The pairing code expired before it was approved.');
      log(`  • It was valid for ${formatTtlLabel(ttlMs)}, matching the pairing code's own TTL.`);
      log('  • Run `signet link` again for a fresh code, or approve later at:');
      log(`    Manual URL: ${pair.verificationUrl}`);
      return 1;
    case 'timeout':
      clearStatusLine();
      log('');
      log('✗ No approval received before the pairing code expired.');
      log(`  • The code was valid for ${formatTtlLabel(ttlMs)}; the CLI waited the full TTL so it can no longer be approved.`);
      log('  • Open this URL in a browser and approve it, then re-run the command:');
      log(`      signet link --api ${client.baseUrl}`);
      log(`    Manual URL: ${pair.verificationUrl}`);
      return 1;
  }
}

async function statusOrThrow(client: LinkClient, code: string): Promise<PollState> {
  return (await client.getStatus(code)).state;
}

/** Translate a network / HTTP failure into a human message. */
function errMessage(err: unknown, fallback: string): string {
  return err instanceof SignetLinkError ? `${fallback}: ${err.message}` : fallback;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearStatusLine(): void {
  process.stdout.write('\x1b[2K\r');
}

/**
 * Best-effort browser open. Ignored where there is no usable opener (CI,
 * headless shells) — the manual URL is already printed, so this is
 * convenience only and never worth failing the command over.
 */
function openBrowser(url: string): void {
  const opener = crossPlatformOpener();
  if (!opener) return;
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    // A missing opener (no xdg-open, headless CI) surfaces as an 'error'
    // event on the child — swallowing it keeps the manual URL path intact.
    child.on('error', () => {});
    child.unref();
  } catch {
    // A failed browser open is not a reason to abort the command.
  }
}

function crossPlatformOpener(): string | null {
  switch (process.platform) {
    case 'darwin':
      return 'open';
    case 'win32':
      return 'start';
    default:
      return process.env.BROWSER || 'xdg-open';
  }
}