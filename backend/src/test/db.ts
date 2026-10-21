import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema/index.js';

/**
 * The parts of Supabase our migrations depend on, recreated for an in-memory Postgres (PGlite).
 * Mirrors Supabase: the `anon`/`authenticated` roles get full table privileges by default,
 * so Row Level Security is the only thing standing between them and the data.
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;

  create schema auth;
  create table auth.users (id uuid primary key, email text);

  -- Same contract as Supabase's auth.uid(): the "sub" claim of the request's JWT.
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(
      coalesce(
        current_setting('request.jwt.claim.sub', true),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      ),
      ''
    )::uuid
  $$;

  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url));

export interface TestDatabase {
  /** Drizzle connected as the database owner (like the API, it bypasses RLS). */
  db: Database;
  client: PGlite;
  /** Inserts a user into auth.users, as Supabase Auth does on sign-up. */
  createAuthUser(email?: string): Promise<string>;
  /** Runs queries as a Supabase role, the way the Data API / Realtime would for that request. */
  asRole<T>(role: 'anon' | 'authenticated', userId: string | null, run: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  await client.exec(SUPABASE_STUB);

  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });

  return {
    db,
    client,

    async createAuthUser(email = `${randomUUID()}@example.test`) {
      const id = randomUUID();
      await client.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      return id;
    },

    asRole(role, userId, run) {
      return client.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        return run(tx);
      });
    },

    close: () => client.close(),
  };
}
