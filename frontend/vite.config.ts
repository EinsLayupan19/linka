import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // Tests never read frontend/.env, so real credentials cannot leak into test runs.
  envDir: mode === 'test' ? false : undefined,
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The first test in a file that renders the whole App pays its cold start (2-3 s alone),
    // which can pass the 5 s default when every file runs in parallel.
    testTimeout: 15_000,
    env: {
      VITE_API_URL: 'http://api.test',
    },
  },
}));
