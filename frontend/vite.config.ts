import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { assertBuildEnv } from './src/lib/buildEnv.ts';

export default defineConfig(({ mode, command }) => {
  // `vite build` (local or on the host) stops here if a variable is missing, not https, or a
  // secret key. loadEnv reads frontend/.env and the host's environment (which wins).
  if (command === 'build') {
    assertBuildEnv(loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_'));
  }

  return {
    plugins: [react(), tailwindcss()],
    // Tests never read frontend/.env, so real credentials cannot leak into test runs.
    envDir: mode === 'test' ? false : undefined,
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      rolldownOptions: {
        output: {
          // Libraries in their own files: they change far less often than Linka's code, so browsers
          // keep them cached across releases. (Splitting by page is in App.tsx.)
          codeSplitting: {
            groups: [
              { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/ },
              { name: 'supabase', test: /node_modules[\\/](@supabase|tslib|iceberg-js)[\\/]/ },
              { name: 'zod', test: /node_modules[\\/]zod[\\/]/ },
            ],
          },
        },
      },
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
  };
});
