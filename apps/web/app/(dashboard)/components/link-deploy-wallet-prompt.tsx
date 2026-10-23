import { CopyCommand } from './copy-command';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/** The terminal command that links a deploy wallet. It takes no handle: the handle is whoever approves in the browser. */
export const CLI_LINK_COMMAND = 'npx @signet/cli link';

/** Where the CLI is documented. */
export const CLI_DOCS_URL = 'https://github.com/blockchain-maxis/signet/blob/main/docs/CLI.md';

/**
 * Shown wherever a claimed handle has no linked deploy wallet — the wallet
 * that claimed the handle (almost always a browser wallet like Freighter) is
 * rarely the keystore identity `stellar contract deploy` signs with, so a
 * brand-new profile renders with nothing to show and no explanation why.
 *
 * Callers gate this on "handle claimed, but every known wallet is primary" —
 * once any non-primary wallet exists, this stops rendering on its own,
 * satisfying "the prompt disappears once a deploy wallet is linked" without
 * needing its own dismiss state.
 */
export function LinkDeployWalletPrompt() {
  return (
    <div className="mt-6 max-w-[640px] border border-amber-800 bg-amber-950/20 px-6 py-5">
      <p className="text-[13px] leading-[1.7] text-[#b8b5a8]" style={mono}>
        No deploy wallet is linked yet. The wallet that claimed your handle is rarely the same key
        you deploy contracts with — until a deploy wallet is linked, there&apos;s nothing here to
        attribute to you.
      </p>
      <p className="mt-4 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]" style={mono}>
        Link one from the terminal
      </p>
      <code className="mt-2 block bg-[#0a0908] px-4 py-3 text-[13px] text-[#f5f4ee]" style={mono}>
        {CLI_LINK_COMMAND}
      </code>
      <p className="mt-3 flex flex-wrap items-center gap-4" style={mono}>
        <CopyCommand command={CLI_LINK_COMMAND} />
        <a
          href={CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-accent)] transition-colors hover:text-[var(--text-accent)]"
        >
          CLI docs<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
    </div>
  );
}
