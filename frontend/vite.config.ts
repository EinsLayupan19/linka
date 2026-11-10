import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { assertBuildEnv } from './src/lib/buildEnv.ts';
import { addContentSecurityPolicy } from './src/lib/contentSecurityPolicy.ts';

/**
 * Adds the Content-Security-Policy to the built index.html, from the same addresses the app is
 * built with. Build only: the dev server needs inline scripts for hot reloading.
 */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  return {
    name: 'linka-content-security-policy',
    apply: 'build',
    transformIndexHtml: {
      // After Vite's own changes, so the hashes cover the final inline scripts.
      order: 'post',
      handler: (html) => addContentSecurityPolicy(html, { apiUrl: env.VITE_API_URL!, supabaseUrl: env.VITE_SUPABASE_URL! }),
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // `vite build` (local or on the host) stops here if a variable is missing, not https, or a
  // secret key. loadEnv reads frontend/.env and the host's environment (which wins).
  const env = command === 'build' ? loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_') : {};
  if (command === 'build') assertBuildEnv(env);

  return {
    plugins: [react(), tailwindcss(), ...(command === 'build' ? [contentSecurityPolicy(env)] : [])],
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
