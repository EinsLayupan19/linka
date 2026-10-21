# Database

PostgreSQL hosted by Supabase, accessed from the API through Drizzle ORM.

## Tables

### `profiles` (Phase 2)

Migration: `backend/src/db/migrations/0000_profiles.sql`. Schema: `backend/src/db/schema/profiles.ts`.

| Column         | Type          | Notes                                                        |
| -------------- | ------------- | ------------------------------------------------------------ |
| `id`           | `uuid` PK     | References `auth.users(id)`, `on delete cascade`             |
| `username`     | `text`        | Unique, lowercase, `^[a-z0-9_]{3,20}$` (CHECK constraint)    |
| `display_name` | `text`        | 1-50 characters, not blank (CHECK constraint)                |
| `avatar_path`  | `text` null   | Storage path, filled in by the media phase                   |
| `created_at`   | `timestamptz` | Default `now()`                                              |
| `updated_at`   | `timestamptz` | Default `now()`, set by Drizzle on update                    |

- No email column: email stays in Supabase `auth.users`.
- The unique constraint on `username` doubles as its lookup index (for discovery later).
- The same rules exist as Zod schemas in `@linka/shared`; the database enforces them again.

**RLS:** enabled. One policy, `profiles_select_own`: role `authenticated` may `SELECT` rows where
`id = (select auth.uid())`. There are no insert, update or delete policies, so browser clients
using the publishable key cannot write profiles at all. Writes go through the API.

## Connection

- Use the Supabase **session pooler** connection string (port 5432, IPv4 compatible).
- `prepare: false` is set on the client so the transaction pooler (port 6543) also works if needed.
- The client is created lazily: the API starts without a database and `GET /api/health` reports
  `database: "not_configured"`.

## Migrations: Drizzle owns everything

All schema changes, including RLS policies and other custom SQL, go through Drizzle migrations in
`backend/src/db/migrations`. Never change the schema by hand in the Supabase dashboard, or the
migrations and the real database will drift apart.

`drizzle.config.ts` limits Drizzle to the `public` schema and treats Supabase's roles
(`anon`, `authenticated`, ...) as existing, so migrations never try to create `auth` objects.

```bash
cd backend

# 1. Table changes: edit src/db/schema/*.ts, then
npm run db:generate

# 2. Other custom SQL (functions, triggers, extra policies): create an empty migration and write it
npx drizzle-kit generate --custom --name=<short_name>

# 3. Apply pending migrations to the database in DATABASE_URL
npm run db:migrate
```

Review every generated SQL file before applying it and commit it with the schema change.
RLS policies can be declared in the schema with `pgPolicy` (as `profiles` does) or written in a
custom migration when they need SQL Drizzle cannot express.

## Security model

- The API connects with a privileged database role, which **bypasses RLS**. Authorization for API
  routes is therefore enforced in the backend: every query is scoped to the user ID from the
  verified access token.
- The browser holds the public Supabase key, which can query any table exposed through Supabase's
  Data API. **Every table gets RLS enabled in the same migration that creates it**, deny by default.
  RLS is what protects data reached directly from the browser (Realtime, Storage, the Data API).

## Testing

Database tests run the real migrations against **PGlite**, an in-memory Postgres (test-only, not a
development database). `backend/src/test/db.ts` recreates the parts of Supabase the migrations use:
the `anon` and `authenticated` roles with Supabase's default table grants, `auth.users`, and
`auth.uid()` reading the request's JWT claims. Tests switch to those roles to check RLS exactly as
the Data API would apply it.

## Planned entities (from PLAN.md)

`conversations`, `conversation_members` (roles: `owner`, `admin`, `member`;
`joined_at`, `last_delivered_at`, `last_read_at`), `messages` (indexed by
`conversation_id, created_at`), `message_attachments`, `calls`, `call_participants`.
