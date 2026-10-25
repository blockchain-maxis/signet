import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../../cli/internal/devui/dist', import.meta.url));

// The app ships inside the signet binary (#579): it builds into the Go
// package that embeds it, and is served by the locked-down local server
// (#576), whose CSP allows only same-origin files and no inline script.
export default defineConfig({
  plugins: [
    react(),
    // dist/ is gitignored except .gitkeep, which `go:embed all:dist` needs
    // to find a directory in a fresh clone; emptyOutDir removes it, so it
    // is written back.
    { name: 'signet-keep-dist', closeBundle: () => writeFileSync(`${outDir}/.gitkeep`, '') },
  ],
  base: './',
  build: {
    outDir,
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
