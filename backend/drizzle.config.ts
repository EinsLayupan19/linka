import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside the app, so it loads backend/.env itself.
if (existsSync('.env')) process.loadEnvFile('.env');

// Drizzle owns every schema change, including RLS policies.
// - Table changes: edit src/db/schema, then `npm run db:generate`.
// - RLS / custom SQL: `npx drizzle-kit generate --custom --name=<name>`, then write the SQL.
// - Apply: `npm run db:migrate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Only manage our own `public` schema; `auth` and the Supabase roles belong to Supabase.
  schemaFilter: ['public'],
  entities: {
    roles: { provider: 'supabase' },
  },
  strict: true,
  verbose: true,
});
