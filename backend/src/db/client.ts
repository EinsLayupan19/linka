import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

/** Any Drizzle Postgres database with our schema (postgres-js in the app, PGlite in tests). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

// postgres() does not connect until the first query, so importing this file is cheap.
// The client is null until DATABASE_URL is configured.
const queryClient = env.DATABASE_URL
  ? postgres(env.DATABASE_URL, {
      max: 10,
      connect_timeout: 5,
      // Supabase's transaction pooler does not support prepared statements.
      // Turning them off keeps both pooler modes working.
      prepare: false,
    })
  : null;

export const db: Database | null = queryClient ? drizzle(queryClient, { schema }) : null;

export async function closeDatabase(): Promise<void> {
  await queryClient?.end({ timeout: 5 });
}
