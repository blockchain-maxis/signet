import type { Config } from 'tailwindcss';

// apps/web's palette and type, as CSS variables (src/styles.css), so the
// local tool looks like Signet.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: 'var(--surface-page)',
        raised: 'var(--surface-raised)',
        line: 'var(--line)',
        ink: 'var(--text)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-faint)',
        accent: 'var(--text-accent)',
        ok: 'var(--ok)',
        bad: 'var(--bad)',
      },
      fontFamily: {
        sans: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: { DEFAULT: '4px' },
    },
  },
  plugins: [],
};

export default config;
