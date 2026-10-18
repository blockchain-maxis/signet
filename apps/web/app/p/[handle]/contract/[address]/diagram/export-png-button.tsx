'use client';

import { useState } from 'react';
import { exportDiagramPng, PNG_EXPORT_ERROR_MESSAGE } from '@signet/visualiser/interactive/png';

export interface ExportPngButtonProps {
  handle: string;
  address: string;
}

/**
 * Client component to download diagram as PNG at 2× scale with embedded IBM Plex Mono font (#519).
 */
export function ExportPngButton({ handle, address }: ExportPngButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const svgUrl = `/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/diagram.svg?theme=auto`;

  const handleExport = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch the standalone SVG with explicit theme support
      const res = await fetch(svgUrl);
      if (!res.ok) {
        throw new Error(PNG_EXPORT_ERROR_MESSAGE);
      }
      const svgText = await res.text();

      await exportDiagramPng(svgText, {
        fileName: `signet-${address}-dark.png`,
        scale: 2,
        theme: 'dark',
      });
    } catch {
      setError(PNG_EXPORT_ERROR_MESSAGE);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleExport}
        disabled={loading}
        aria-label="Download PNG diagram"
        className="inline-block text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 text-[#f5f4ee] hover:text-[#e05a4b] transition-colors disabled:opacity-50"
      >
        {loading ? 'Exporting PNG...' : 'Download PNG'}
      </button>

      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="mt-1 flex flex-wrap items-center gap-1 text-xs text-[#e05252]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          <span>PNG export failed;</span>
          <a href={svgUrl} download className="underline underline-offset-2 hover:text-[#f0806f]">
            download the SVG instead
          </a>
        </div>
      )}
    </div>
  );
}
