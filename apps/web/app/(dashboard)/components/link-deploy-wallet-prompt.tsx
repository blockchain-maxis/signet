const mono = { fontFamily: 'var(--font-mono)' } as const;

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
        No deploy wallet is linked yet. The wallet that claimed your handle is rarely the same
        key you deploy contracts with — until a deploy wallet is linked, there&apos;s nothing here to
        attribute to you.
      </p>
      <p className="mt-4 text-[10px] uppercase tracking-[0.2em] text-[#5e5b51]" style={mono}>
        Link one from the terminal
      </p>
      <code className="mt-2 block bg-[#0a0908] px-4 py-3 text-[13px] text-[#f5f4ee]" style={mono}>
        npx @signet/cli link
      </code>
    </div>
  );
}
