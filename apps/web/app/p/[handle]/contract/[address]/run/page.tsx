'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { SIGNET_DEV_RELEASED } from '@/lib/contract-tabs';

interface RunPageProps {
  params: Promise<{ handle: string; address: string }>;
}

function RunPageClient({ address, network }: { address: string; network: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const confirm = useCallback(() => {
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleCopy = useCallback(async () => {
    const command = network === 'mainnet' ? `signet dev ${address} --network mainnet` : `signet dev ${address}`;
    try {
      await navigator.clipboard.writeText(command);
      confirm();
    } catch {
      const el = document.createElement('textarea');
      el.value = command;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      confirm();
    }
  }, [address, network, confirm]);

  const command = network === 'mainnet' ? `signet dev ${address} --network mainnet` : `signet dev ${address}`;

  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.22em] text-[#8a8779] mb-6" style={{ fontFamily: 'var(--font-mono)' }}>
        Run locally
      </h2>

      {!SIGNET_DEV_RELEASED && (
        <div
          className="mb-6 p-4 rounded border border-[#8b1a1a] bg-[#1a0f0f] text-[#ffb4a8]"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: '1.6' }}
          role="status"
          aria-live="polite"
        >
          <strong>Not released yet:</strong> the <code>signet dev</code> command (epic F, #563) is not
          available in the current CLI. The command below is what it will be.
        </div>
      )}

      <div className="mb-8">
        <div className="flex items-center gap-4 mb-2">
          <code
            className="flex-1 text-[13px] text-[#e8e6dc] bg-[#141310] px-3 py-2 rounded border border-[#2a2823]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {command}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            title={command}
            aria-label={copied ? 'Command copied' : `Copy command: ${command}`}
            className="flex h-9 w-9 items-center justify-center rounded border border-[#2a2823] bg-[#141310] text-[#4a4740] hover:text-[#b8b5a8] hover:border-[#3d3a33] transition-colors"
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2 6l3 3 5-5" stroke="#4ade80" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="4" y="4" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4 3V2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <span
            role="status"
            aria-live="polite"
            className="text-[11px] text-[#4ade80]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {copied ? 'Copied' : ''}
          </span>
        </div>
      </div>

      <div className="space-y-6 text-[13px] leading-[1.7] text-[#8a8779]" style={{ fontFamily: 'var(--font-mono)' }}>
        <p>
          This command forks the deployed contract&apos;s code and storage from <strong>{network}</strong>
          into a local environment, hot-swaps your locally rebuilt WASM while keeping storage,
          replays saved calls and recent real transactions after each reload, and diffs results
          against the deployed version.
        </p>
        <p>
          It also provides a one-off <code>signet sandbox call</code> for ad-hoc invocations and a
          local web UI the CLI serves on <code>localhost</code> for interactive exploration.
        </p>

        <h3 className="text-[11px] uppercase tracking-[0.22em] text-[#5e5b51] mt-8 mb-2" style={{ fontFamily: 'var(--font-mono)' }}>
          Requirements
        </h3>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Signet CLI</strong> — install per{' '}
            <a
              href="https://github.com/blockchain-maxis/signet/blob/main/docs/CLI.md"
              target="_blank"
              rel="noreferrer"
              className="text-[#8b1a1a] hover:text-[#c2410c] underline"
            >
              docs/CLI.md
            </a>{' '}
            (landed in #352).
          </li>
          <li>
            <strong>Rust toolchain</strong> for execution — see{' '}
            <a
              href="https://github.com/blockchain-maxis/signet/blob/main/docs/CONTRACT_SANDBOX_DESIGN.md"
              target="_blank"
              rel="noreferrer"
              className="text-[#8b1a1a] hover:text-[#c2410c] underline"
            >
              docs/CONTRACT_SANDBOX_DESIGN.md
            </a>{' '}
            (#642).
          </li>
        </ul>

        <p className="mt-6 p-4 rounded border border-[#2a2823] bg-[#141310] text-[#b8b5a8]">
          <strong>Nothing runs on signet.dev.</strong> The sandbox executes entirely on your machine
          through the CLI; no contract code or storage ever leaves your local environment.
        </p>
      </div>
    </section>
  );
}

export default async function RunPage({ params }: RunPageProps) {
  const { handle, address } = await params;
  const { attributeContract } = await import('@/lib/contract-attribution');
  const attribution = await attributeContract(handle, address);

  if (attribution.status !== 'attributed') {
    return null;
  }

  const network = attribution.contract.network;

  return <RunPageClient address={address} network={network} />;
}