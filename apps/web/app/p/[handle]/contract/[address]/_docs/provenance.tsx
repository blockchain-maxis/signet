import type { Network } from '@signet/types';
import type { SpecInput } from '@/lib/contract-overview';
import { buildProvenanceModel, formatExtractedAt } from '@/lib/contract-provenance';
import { loadSpecExtractedAt } from '@/lib/server/contract-overview-source';
import { SectionLabel } from '../../../_components/section-label';
import { CopyAddress } from '../../../copy-address';
import { ExternalLink } from '../external-link';

const MONO = { fontFamily: 'var(--font-mono)' } as const;

const LINK =
  'text-[#e05a4b] transition-colors hover:text-[#f0806f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

/**
 * Provenance strip (#471, design §2.2): the WASM hash the docs were generated
 * from, the toolchain facts the WASM itself states, and the commands to
 * re-derive the interface. It renders on the Overview and at the top of the
 * Functions tab. Every line after the hash is omitted when the WASM did not
 * state it; with no known hash at all the strip does not render.
 */
export async function Provenance({
  address,
  network,
  spec,
  wasmHash,
  heading = false,
}: {
  address: string;
  network: Network;
  spec: SpecInput;
  /** Indexed hash: the fallback when no spec was decoded. */
  wasmHash: string | null;
  /** Show a "Provenance" section label above the strip (the Overview does; Functions has its own heading). */
  heading?: boolean;
}) {
  const knownHash = (spec.kind === 'spec' ? spec.spec.wasmHash : undefined) ?? wasmHash;
  const extractedAt =
    spec.kind === 'spec' && knownHash ? await loadSpecExtractedAt(knownHash.toLowerCase()) : null;
  const m = buildProvenanceModel(spec, {
    address,
    network,
    indexedWasmHash: wasmHash,
    extractedAt,
  });
  if (!m) return null;

  return (
    <section aria-label="Provenance" data-testid="contract-provenance" style={MONO}>
      {heading && (
        <div className="mb-4">
          <SectionLabel>Provenance</SectionLabel>
        </div>
      )}
      <dl className="divide-y divide-[#1f1d19] border-y border-[#1f1d19] text-[13px] leading-[1.7]">
        <div className="grid gap-x-8 gap-y-1 py-3 sm:grid-cols-[9rem_1fr]">
          <dt className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]">WASM hash</dt>
          <dd className="min-w-0 text-[#f5f4ee]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="break-all" data-testid="provenance-wasm-hash">
                <CopyAddress
                  address={m.wasmHash}
                  display={m.wasmHash}
                  label="WASM hash"
                  copiedLabel="WASM hash copied"
                />
              </span>
              <ExternalLink
                href={m.explorerUrl}
                className={`text-[10px] uppercase tracking-[0.2em] ${LINK}`}
              >
                Stellar Expert
              </ExternalLink>
            </div>
          </dd>
        </div>

        {(m.built || m.protocol || m.reader) && (
          <div className="grid gap-x-8 gap-y-1 py-3 sm:grid-cols-[9rem_1fr]">
            <dt className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]">Built and read</dt>
            <dd className="min-w-0 space-y-1 text-[#b8b5a8]">
              {m.built && <p data-testid="provenance-built">{m.built}</p>}
              {m.protocol && <p data-testid="provenance-protocol">{m.protocol}</p>}
              {m.reader && (
                <p data-testid="provenance-reader">
                  Read with @stellar/stellar-sdk {m.reader.sdkVersion}
                  {m.reader.extractedAt && (
                    <>
                      {' '}
                      at{' '}
                      <time dateTime={m.reader.extractedAt} className="tabular-nums">
                        {formatExtractedAt(m.reader.extractedAt)}
                      </time>
                    </>
                  )}
                </p>
              )}
            </dd>
          </div>
        )}
      </dl>

      <details className="border-b border-[#1f1d19]" data-testid="provenance-rederive">
        <summary
          className={`cursor-pointer select-none py-3 text-[10px] uppercase tracking-[0.22em] text-[#b8b5a8] transition-colors hover:text-[#f5f4ee] ${LINK}`}
        >
          Re-derive this
        </summary>
        <div className="pb-4">
          <p className="max-w-[65ch] text-[13px] leading-[1.7] text-[#b8b5a8]">
            Fetch the WASM from the network, check its hash against the one above, and read its
            interface with the Stellar CLI.
          </p>
          <pre
            className="mt-3 overflow-x-auto border border-[#1f1d19] bg-[#12100d] p-4 text-[12px] leading-[1.8] text-[#f5f4ee]"
            tabIndex={0}
            data-testid="provenance-commands"
          >
            {m.commands.join('\n')}
          </pre>
          <div className="mt-3">
            <CopyAddress
              address={m.commands.join('\n')}
              display="Copy commands"
              label="re-derive commands"
              copiedLabel="Commands copied"
            />
          </div>
        </div>
      </details>
    </section>
  );
}
