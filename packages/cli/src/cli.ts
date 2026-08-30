/**
 * `signet` command-line entrypoint: argument parsing and dispatch.
 *
 * Argument parsing is hand-rolled on purpose — the CLI has one command and a
 * handful of flags, and pulling in `commander`/`yargs` would drag a runtime
 * dependency in for work a small loop already covers.
 */

import { LINK_PAIR_TTL_MS, LINK_POLL_INTERVAL_MS } from '@signet/types';
import { LinkClient } from './link-client.ts';
import { linkCommand } from './link.ts';

/** Base URL of the Signet link server. `--api` wins over `SIGNET_API_URL`. */
const DEFAULT_API = 'http://localhost:3000';

function apiBaseUrl(explicit?: string): string {
  if (explicit) return explicit.replace(/\/$/, '');
  const fromEnv = process.env.SIGNET_API_URL;
  return (fromEnv ?? DEFAULT_API).replace(/\/$/, '');
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    printHelp();
    return 0;
  }

  const [command, ...rest] = argv;

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log('signet 0.0.0');
    return 0;
  }
  if (command === 'link') {
    return runLink(rest);
  }

  console.error(`signet: unknown command '${command}'`);
  printHelp();
  return 1;
}

interface LinkArgs {
  help: boolean;
  api?: string;
}

/** Pure arg parsing for `signet link`, extracted so tests stay off the network. */
export function parseLinkArgs(argv: string[]): { ok: true; args: LinkArgs } | { ok: false; message: string } {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { ok: true, args: { help: true } };
  }

  const args: LinkArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--api') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, message: `signet link: '--api' requires a URL value` };
      }
      args.api = value;
      i++;
    } else if (arg.startsWith('--api=')) {
      args.api = arg.slice('--api='.length);
    } else {
      return { ok: false, message: `signet link: unknown argument '${arg}'` };
    }
  }
  return { ok: true, args };
}

async function runLink(argv: string[]): Promise<number> {
  const parsed = parseLinkArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    printLinkHelp();
    return 1;
  }
  if (parsed.args.help) {
    printLinkHelp();
    return 0;
  }

  const baseUrl = apiBaseUrl(parsed.args.api);
  return linkCommand({ client: new LinkClient(baseUrl) });
}

function printHelp(): void {
  console.log(
    [
      'signet — Signet terminal tooling',
      '',
      'Usage:',
      '  signet link [--api <url>]   Link this machine to your Signet account',
      '  signet --help               Show this help',
      '  signet --version            Show the version',
      '',
      'Environment:',
      '  SIGNET_API_URL   Base URL of the Signet link server (default http://localhost:3000)',
    ].join('\n'),
  );
}

function printLinkHelp(): void {
  console.log(
    [
      'signet link — link this machine to your Signet account',
      '',
      'Usage:',
      '  signet link [options]',
      '',
      'Options:',
      '  --api <url>   Signet link server base URL (default $SIGNET_API_URL or http://localhost:3000)',
      '  -h, --help    Show this help',
      '',
      `The command prints a pairing code and an approval URL, waits up to the pairing`,
      `code's TTL (${LINK_PAIR_TTL_MS / 60_000} minutes / ${LINK_POLL_INTERVAL_MS / 1000}s polls) for you to approve`,
      `in a browser, and on timeout shows how to retry with the manual URL.`,
    ].join('\n'),
  );
}