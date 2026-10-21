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

  -- Supabase Realtime (Broadcast from Database), reduced to what our migrations use.
  -- realtime.send() stores the event in realtime.messages, from where Supabase delivers it.
  -- To authorize a private channel join, Supabase reads realtime.messages as the joining user
  -- with realtime.topic() returning the requested topic: RLS decides. Tests do the same.
  create schema realtime;
  create table realtime.messages (
    id bigserial primary key,
    topic text not null,
    extension text not null,
    event text,
    payload jsonb,
    private boolean default false,
    inserted_at timestamptz not null default now()
  );
  alter table realtime.messages enable row level security;
  grant usage on schema realtime to anon, authenticated;
  grant select, insert on realtime.messages to anon, authenticated;
  grant usage on all sequences in schema realtime to anon, authenticated;

  create function realtime.topic() returns text language sql stable as $$
    select nullif(current_setting('realtime.topic', true), '')
  $$;

  create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void language plpgsql as $$
  begin
    insert into realtime.messages (payload, event, topic, private, extension)
    values (payload, event, topic, private, 'broadcast');
  end;
  $$;
`;

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url));

export interface TestDatabase {
  /** Drizzle connected as the database owner (like the API, it bypasses RLS). */
  db: Database;
  client: PGlite;
  /** Inserts a user into auth.users, as Supabase Auth does on sign-up. */
  createAuthUser(email?: string): Promise<string>;
  /** A signed-up user who has also set up a profile. Returns the user id. */
  createUser(username?: string): Promise<string>;
  /** Runs queries as a Supabase role, the way the Data API / Realtime would for that request. */
  asRole<T>(role: 'anon' | 'authenticated', userId: string | null, run: (tx: Transaction) => Promise<T>): Promise<T>;
  /**
   * Simulates Supabase's private-channel join check: may this user read Broadcast messages
   * on `topic`? (Realtime asks RLS on realtime.messages with realtime.topic() = topic.)
   */
  canJoinTopic(role: 'anon' | 'authenticated', userId: string | null, topic: string): Promise<boolean>;
  /** Broadcast events stored for a topic (what Realtime would deliver), oldest first. */
  broadcastsOn(topic: string): Promise<{ event: string; payload: unknown; private: boolean }[]>;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  await client.exec(SUPABASE_STUB);

  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });

  async function createAuthUser(email = `${randomUUID()}@example.test`) {
    const id = randomUUID();
    await client.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
    return id;
  }

  function asRole<T>(role: 'anon' | 'authenticated', userId: string | null, run: (tx: Transaction) => Promise<T>) {
    return client.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
      return run(tx);
    });
  }

  let userCount = 0;

  return {
    db,
    client,
    createAuthUser,

    async createUser(username = `user_${++userCount}_${randomUUID().slice(0, 6)}`) {
      const id = await createAuthUser(`${username}@example.test`);
      await client.query('insert into profiles (id, username, display_name) values ($1, $2, $3)', [
        id,
        username,
        username,
      ]);
      return id;
    },

    asRole,

    canJoinTopic(role, userId, topic) {
      // Like Supabase: insert a probe message, try to read it as the user, roll back.
      return client.transaction(async (tx) => {
        await tx.query(
          "insert into realtime.messages (topic, extension, event, payload, private) values ($1, 'broadcast', 'probe', '{}', true)",
          [topic],
        );
        await tx.exec(`set local role ${role}`);
        const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.query(`select set_config('realtime.topic', $1, true)`, [topic]);
        const { rows } = await tx.query("select 1 from realtime.messages where topic = $1 and event = 'probe'", [topic]);
        await tx.rollback();
        return rows.length > 0;
      });
    },

    async broadcastsOn(topic) {
      const { rows } = await client.query<{ event: string; payload: unknown; private: boolean }>(
        'select event, payload, private from realtime.messages where topic = $1 order by id',
        [topic],
      );
      return rows;
    },

    close: () => client.close(),
  };
}
