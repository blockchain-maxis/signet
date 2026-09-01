import { ImageResponse } from 'next/og';
import { getProfile, getOperationsResult, computeStats, formatCount } from '@/lib/profiles';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Social card for a profile — makes the "citable record" actually shareable.
// Uses system fonts only (no network fetch) so it renders in any build env.
export default async function OgImage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const profile = await getProfile(handle);
  const result = profile ? await getOperationsResult(handle) : null;
  const stats = result ? computeStats(result.operations) : null;
  // A capped record renders as "412+" rather than "412": the card is the most
  // widely reshared surface, so it must not state a lower bound as a total.
  const truncated = result?.truncated ?? false;
  const name = profile?.name ?? handle;

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 28, letterSpacing: 4 }}>
          <div style={{ width: 18, height: 18, borderRadius: 9, background: '#8b1a1a' }} />
          SIGNET
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: -2 }}>{name}</div>
          <div style={{ fontSize: 30, color: '#8a8779', marginTop: 8 }}>@{handle}</div>
        </div>

        <div style={{ display: 'flex', gap: 64, fontSize: 26, color: '#b8b5a8' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 56, color: '#f5f4ee' }}>{stats?.reputation ?? 0}</span>
            <span style={{ color: '#5e5b51' }}>REPUTATION</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 56, color: '#f5f4ee' }}>
              {formatCount(stats?.invocations ?? 0, truncated)}
            </span>
            <span style={{ color: '#5e5b51' }}>INVOCATIONS</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 56, color: '#f5f4ee' }}>
              {formatCount(stats?.uniqueFunctions ?? 0, truncated)}
            </span>
            <span style={{ color: '#5e5b51' }}>FUNCTIONS</span>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
