import { normalizeNetwork } from '@signet/types';
import type { AttributedContract } from '@/lib/contract-attribution';
import { buildHeaderModel } from '@/lib/contract-header';
import { STELLAR_NETWORK } from '@/lib/chain';
import { loadIndexedAsOf, loadLiveWasmHash } from '@/lib/server/contract-header-source';
import { CopyAddress } from '../../../copy-address';
import { ExternalLink } from '../external-link';

const MONO = { fontFamily: 'var(--font-mono)' } as const;

const LINK =
  'text-[#e05a4b] transition-colors hover:text-[#f0806f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-1 py-3 sm:grid-cols-[9rem_1fr]">
      <dt className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]">{label}</dt>
      <dd className="min-w-0 text-[13px] leading-[1.7] text-[#b8b5a8]">{children}</dd>
    </div>
  );
}

/**
 * Contract header (#448, design §2.2), rendered by the layout so every tab
 * carries it. Server component: the only client code is the existing copy
 * button. The labelling rules live in `lib/contract-header.ts`.
 */
export async function ContractHeader({
  handle,
  contract,
}: {
  handle: string;
  contract: AttributedContract;
}) {
  const [live, indexedAsOf] = await Promise.all([
    loadLiveWasmHash(contract.address, normalizeNetwork(contract.network)),
    contract.wasmHash ? loadIndexedAsOf(contract.address) : Promise.resolve(null),
  ]);
  const m = buildHeaderModel(contract, live, {
    handle,
    configuredNetwork: STELLAR_NETWORK,
    indexedAsOf,
  });

  return (
    <section aria-label="Contract details" data-testid="contract-header">
      <dl
        className="divide-y divide-[#1f1d19] border-y border-[#1f1d19]"
        style={MONO}
      >
        <Row label="Address">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="break-all">
              <CopyAddress address={m.address} display={m.address} />
            </span>
            <ExternalLink
              href={m.addressUrl}
              className={`text-[10px] uppercase tracking-[0.2em] ${LINK}`}
            >
              Stellar Expert
            </ExternalLink>
          </div>
        </Row>

        <Row label="Network">
          <span
            className={`inline-block border px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] ${
              m.network.mismatch
                ? 'border-[#8b1a1a] bg-[#1a0d0b] text-[#f0806f]'
                : 'border-[#2a2822] text-[#f5f4ee]'
            }`}
            data-testid="contract-network"
          >
            {m.network.value}
          </span>
          {m.network.note && (
            <p className="mt-2 text-[#f0806f]" role="status">
              {m.network.note}
            </p>
          )}
        </Row>

        <Row label="WASM hash">
          {m.wasm.hash ? (
            <p className="break-all text-[#f5f4ee]" data-testid="contract-wasm-hash">
              {m.wasm.hash}
            </p>
          ) : null}
          <p className={m.wasm.hash ? 'text-[#8a8779]' : 'text-[#f5f4ee]'} data-testid="contract-wasm-source">
            {m.wasm.label}
          </p>
          {m.wasm.note && <p className="mt-1 text-[#b8b5a8]">{m.wasm.note}</p>}
        </Row>

        <Row label="Deploy tx">
          <ExternalLink href={m.deployTx.url} className={`break-all ${LINK}`}>
            {m.deployTx.hash}
          </ExternalLink>
        </Row>

        <Row label="Deployed">
          <time dateTime={contract.deployedAt} className="text-[#f5f4ee] tabular-nums">
            {m.deployedOn}
          </time>
        </Row>

        <Row label="Deployer">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <CopyAddress address={m.deployer.pubkey} display={m.deployer.display} />
            <ExternalLink
              href={m.deployer.url}
              className={`text-[10px] uppercase tracking-[0.2em] ${LINK}`}
            >
              Stellar Expert
            </ExternalLink>
          </div>
          {/* Plain text: the identity strip above already links the handle. */}
          <p className="mt-1 text-[#8a8779]">linked to @{m.handle}</p>
        </Row>
      </dl>
    </section>
  );
}
