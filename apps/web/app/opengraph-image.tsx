import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Default social card for every route that doesn't define its own
// opengraph-image (profile pages override this with per-handle stats).
// Uses system fonts only (no network fetch) so it renders in any build env.
export default function OgImage() {
  return new ImageResponse(
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
    </div>,
    size,
  );
}
