import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests never read backend/.env, so they cannot accidentally hit a real database
    // or Supabase project. Database tests use an in-memory PGlite instead.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: '',
      SUPABASE_URL: '',
      CORS_ORIGIN: 'http://localhost:5173',
    },
    // Each PGlite instance takes a moment to start and migrate.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Many PGlite instances migrating at once starve each other (CPU and memory) until setup
    // times out; a few workers finish just as fast overall.
    maxWorkers: 4,
  },
});
