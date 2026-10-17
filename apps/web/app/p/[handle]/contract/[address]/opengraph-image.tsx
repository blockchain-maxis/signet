import { ImageResponse } from 'next/og';
import { attributeContract } from '@/lib/contract-attribution';
import { formatDate } from '@/lib/format-date';
import { specCaches } from '@/lib/server/contract-spec';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

function truncate(str: string, head: number, tail: number): string {
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

async function getCachedFunctionCount(wasmHash: string | null): Promise<number | null> {
  if (!wasmHash) return null;
  const caches = specCaches();
  for (const cache of caches) {
    try {
      const spec = await cache.get(wasmHash);
      if (spec && Array.isArray(spec.functions)) {
        return spec.functions.length;
      }
    } catch {
      // Ignore cache lookup errors, never throw or block
    }
  }
  return null;
}

function GenericCard() {
  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#0a0908',
        color: '#f5f4ee',
        padding: '72px',
        fontFamily: 'monospace',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 28, letterSpacing: 4 }}
      >
        <div style={{ width: 18, height: 18, borderRadius: 9, background: '#8b1a1a' }} />
        SIGNET
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontSize: 72,
            fontWeight: 700,
            letterSpacing: -2,
            lineHeight: 1.05,
          }}
        >
          <span>A verifiable career</span>
          <span>record for developers</span>
        </div>
        <div style={{ fontSize: 28, color: '#8a8779', marginTop: 24 }}>
          Built on Stellar/Soroban
        </div>
      </div>

      <div style={{ display: 'flex', fontSize: 22, color: '#5e5b51', letterSpacing: 2 }}>
        signet.dev
      </div>
    </div>
  );
}

export default async function OgImage({
  params,
}: {
  params: Promise<{ handle: string; address: string }>;
}) {
  const { handle, address } = await params;
  const attribution = await attributeContract(handle, address);

  if (attribution.status !== 'attributed') {
    return new ImageResponse(<GenericCard />, size);
  }

  const { contract } = attribution;
  const shortAddress = truncate(contract.address, 8, 6);
  const functionCount = await getCachedFunctionCount(contract.wasmHash);
  const deployDate = formatDate(contract.deployedAt);

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0a0908',
          color: '#f5f4ee',
          padding: '72px',
          fontFamily: 'monospace',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 28,
            letterSpacing: 4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 18, height: 18, borderRadius: 9, background: '#8b1a1a' }} />
            SIGNET
          </div>
          <div style={{ fontSize: 22, color: '#5e5b51', letterSpacing: 2 }}>
            CONTRACT
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: -2 }}>
            {shortAddress}
          </div>
          <div style={{ fontSize: 32, color: '#8a8779', marginTop: 12 }}>
            @{handle}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 64, fontSize: 26, color: '#b8b5a8' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 48, color: '#f5f4ee' }}>
              {contract.network.toUpperCase()}
            </span>
            <span style={{ color: '#5e5b51', marginTop: 4 }}>NETWORK</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 48, color: '#f5f4ee' }}>
              {deployDate}
            </span>
            <span style={{ color: '#5e5b51', marginTop: 4 }}>DEPLOYED</span>
          </div>

          {functionCount !== null && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 48, color: '#f5f4ee' }}>
                {functionCount}
              </span>
              <span style={{ color: '#5e5b51', marginTop: 4 }}>FUNCTIONS</span>
            </div>
          )}
        </div>
      </div>
    ),
    size,
  );
}
