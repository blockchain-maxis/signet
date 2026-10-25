import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests (#581–#587): React in jsdom with Testing Library. The
// pure modules keep their node:test files (`*.test.ts`).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    restoreMocks: true,
    // userEvent types character by character; a busy CI box needs room.
    testTimeout: 20_000,
    setupFiles: ['./src/test-setup.ts'],
  },
});
