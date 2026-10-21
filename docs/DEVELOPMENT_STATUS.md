# Development status

| Phase | Name                                   | Status      |
| ----- | -------------------------------------- | ----------- |
| 1     | Foundation                             | Complete    |
| 2     | Authentication & user foundation       | Complete    |
| 3     | Database & conversation foundation     | Complete    |
| 4     | Realtime messaging                     | In review   |
| 5     | Read, delivery, presence & typing      | Not started |
| 6     | Media & file sharing                   | Not started |
| 7     | Voice calls                            | Not started |
| 8     | Video calls                            | Not started |
| 9     | Polish, security & scalability         | Not started |
| 10    | Production preparation & deployment    | Not started |

## Phase 1: Foundation

- npm workspaces: `shared`, `backend`, `frontend`
- Shared Zod schemas: API error shape, health response
- Express API: env validation, helmet, CORS, JSON body limit, 404 + error handler, `GET /api/health`
- Drizzle + postgres client and config
- React app shell, error boundary, 404 page, status page (API / database / Supabase config)
- Supabase browser client (lazy, rejects secret keys)
- ESLint, Vitest, React Testing Library, Supertest

## Phase 2: Authentication & user foundation

Done:

- Supabase Auth in the browser: register, login, logout, password reset, session persistence and
  refresh, auth state (`AuthProvider`), protected routes
- API token verification (`requireAuth`, JWKS via `jose`) and authenticated API requests
- `profiles` table with constraints and deny-by-default RLS (migration `0000_profiles`)
- `GET/POST/PATCH /api/users/me`, Zod-validated, scoped to the token's user
- Pages: login, register, forgot password, reset password, profile setup, profile
- Tests: shared validation, token verification, RLS and constraints on real Postgres (PGlite),
  profile store, API routes, auth state, route guards, auth and profile pages

Not verifiable until a Supabase project exists:

- Real sign-up, confirmation email, login, refresh and reset against Supabase Auth
- Token verification against the project's real JWKS endpoint
- Applying the migration to the hosted database and RLS there (tested on PGlite only)

## Phase 3: Conversations & database foundation

Done:

- Tables: `conversations`, `conversation_members`, `messages`, `message_attachments`, `calls`,
  `call_participants` with Postgres enums, foreign keys, CHECK constraints and indexes
  (migrations `0001_rls_helpers`, `0002_conversations`); see [DATABASE.md](DATABASE.md)
- Duplicate 1:1 conversations prevented by the database (ordered, unique user pair)
- RLS on every table: members-only `SELECT` via `private.is_conversation_member()`, no write policies
- API: create/list/read/rename conversations, add/remove members, change roles, transfer
  ownership, leave; all authorized by membership and role
- Username search: `GET /api/users/search` (prefix, case-insensitive, max 20, no email)
- Member-checked services for storing messages and starting calls (no routes yet)
- Tests: RLS and constraints on real Postgres (PGlite) with guard and control tests, role rules,
  every conversation route, search, messages, calls

Not in this phase (by design): any frontend UI, message routes and pagination, realtime, uploads,
calls beyond the database.

Not verifiable until a Supabase project exists:

- Applying migrations `0000`-`0002` to the hosted database
- RLS and the `private` helper on hosted Supabase (tested on PGlite only)
- That the `private` schema stays unexposed in the project's API settings (default)

## Phase 4: Realtime messaging

Done:

- Realtime architecture decided and documented: Supabase Broadcast from Database, one private
  channel per conversation (`conversation:<id>`, event `message.created`), authorized by RLS on
  `realtime.messages` through the membership helper ([ARCHITECTURE.md](ARCHITECTURE.md#messaging-and-realtime-phase-4))
- Migrations `0003` (millisecond `created_at`, `client_id` + unique index) and `0004` (broadcast
  trigger, topic helper, realtime policy)
- API: `GET/POST /api/conversations/:id/messages` with cursor pagination and idempotent sends;
  conversation list with latest-message preview, sorted by last activity
- UI: conversation list, conversation view, message history with "Load earlier messages",
  composer, pending/failed/retry states, live status notice, new chat by username search;
  desktop split view and mobile single-pane layout
- Client realtime: joins only the open conversation, leaves on navigation, dedupes by id, orders by
  `(createdAt, id)`, refetches the newest page after every (re)join
- Tests: message API (auth, membership, spoofing, limits, retries, pagination with tied timestamps,
  cursor/limit validation), broadcast trigger and channel authorization on PGlite, realtime client
  service, message reducer, chat pages (list, history, pagination, sending, failures, realtime,
  duplicates, reconnect, new chat)

Not in this phase (by design): typing, presence, read/delivery receipts, unread counts,
attachments, calls, push notifications, editing/deleting messages, offline support, live updates for
conversations that are not open.

Not verifiable until a Supabase project exists:

- Real WebSocket delivery: joining private channels, receiving `message.created`, reconnect
  behavior of supabase-js against the real Realtime service
- The trigger and `realtime.send()` on hosted Supabase, including its daily partitions (tested
  against a stand-in `realtime` schema on PGlite)
- Hosted enforcement of the `realtime.messages` policy with "private channels only" enabled
- The chat UI in a real browser (it sits behind sign-in); it was exercised through component tests

### Supabase setup (dashboard)

1. **Create the project** (hosted). Then copy:
   - *Project Settings > API Keys*: the **publishable** key (or legacy `anon` key) ->
     `frontend/.env` `VITE_SUPABASE_PUBLISHABLE_KEY`. Never the secret / `service_role` key.
   - Project URL (`https://<ref>.supabase.co`) -> `frontend/.env` `VITE_SUPABASE_URL` **and**
     `backend/.env` `SUPABASE_URL`.
   - *Connect > Session pooler* connection string -> `backend/.env` `DATABASE_URL`.
2. **JWT signing keys.** *Project Settings > JWT Keys*: the current key must be an asymmetric key
   (ECC P-256 or RSA), which is the default for new projects. If the project still uses the legacy
   HS256 shared secret, migrate to signing keys there. The API only accepts ES256/RS256 tokens.
3. **Auth URL configuration.** *Authentication > URL Configuration*:
   - Site URL: `http://localhost:5173` (production URL later).
   - Redirect URLs: add `http://localhost:5173/**`.
4. **Email confirmation.** *Authentication > Sign In / Providers > Email*: keep "Confirm email" on.
5. **Password length.** Same page: set the minimum password length to **8** to match the app.
6. **Apply the migrations:** `cd backend && npm run db:migrate`.
7. **API exposed schemas.** *Project Settings > Data API > Exposed schemas*: leave the default
   (`public`, `graphql_public`). Do **not** add `private`: it holds the RLS helper function.
8. **Realtime: private channels only.** *Realtime > Settings*: turn **off** "Allow public access"
   so only private, RLS-authorized channels can be joined. Linka's channels are all private.
9. **Check realtime delivery** after applying the migrations: open the same conversation in two
   browsers signed in as two members; a message sent in one should appear in the other without a
   reload. If it does not, check *Database > Logs* for `linka: broadcasting message ... failed`.

Supabase's built-in email service is heavily rate limited and meant for testing; configure custom
SMTP (*Authentication > Emails > SMTP Settings*) before real users sign up.

## Decisions

| Decision | Choice |
| --- | --- |
| Shared code | `shared/` workspace package (`@linka/shared`) |
| Migrations | Drizzle owns all migrations, including RLS / custom SQL |
| Env files | Separate `frontend/.env.example` and `backend/.env.example` |
| Database | Hosted Supabase project, no local database |
| Auth | Browser talks to Supabase Auth directly; API verifies tokens (no `/api/auth/*` proxy) |
| Token verification | Local JWT verification against the project's JWKS (ES256/RS256 only) |
| Profile creation | Onboarding step after first login (`POST /api/users/me`), not at sign-up |
| Profile writes | API only; RLS has a select-own policy and no write policies |
| Profile visibility | Own full profile; public fields of fellow members and search results via the API. RLS: own row only |
| Username | Unique, lowercase `a-z 0-9 _`, 3-20 chars; not editable yet |
| User discovery | Username prefix search, signed-in only, max 20 results, never email |
| Profile pictures | Media/storage phase (6) |
| Group roles | `owner`, `admin`, `member`; rules in ARCHITECTURE.md and `conversationPermissions.ts` |
| Ownership | Exactly one owner; leaves only after transferring; transfer makes the old owner an admin |
| 1:1 conversations | Exactly two members, unique per pair (database), cannot be left or changed; creating an existing one returns it |
| Non-member access | 404, same as a missing conversation (existence is never revealed) |
| Conversation writes | API only; RLS is select-only on every table |
| Deleted accounts | Their messages stay with `sender_id = null`; memberships are removed |
| Message ordering | `(created_at, id)`, cursor-ready; soft delete via `deleted_at` |
| Read/delivery markers | Columns exist on `conversation_members` (PLAN.md §5), logic in Phase 5 |
| Realtime | Broadcast from Database, private channel per conversation, event `message.created`, payload = shared `Message` |
| Realtime writes | Only the database trigger publishes; no INSERT policy for clients |
| Removed members on an open channel | May keep receiving live events until their token refreshes (accepted; no short token lifetimes) |
| Message identity | Message id; the sender's `clientId` makes sends idempotent |
| Message content | Stored exactly as typed; must contain non-whitespace, max 4000 characters |
| Pagination cursor | Opaque base64url of `[createdAt, id]`; default 50, max 100 per page |
| Reconnect | Refetch the newest page on every join and merge by id; restart from it if it does not connect |
| Conversation order | By last activity (`updated_at`, bumped by each new message) |
| Enums | Postgres enums built from the shared Zod value lists |
| Realtime messaging | Postgres Changes vs Broadcast tradeoff presented before Phase 4 |
| TURN | Documented limitation in Phase 7; hosted provider only when needed |

## Known issues / notes

- `npm audit` reports 4 moderate findings, all one esbuild dev-server advisory (GHSA-67mh-4wv8-2f99)
  pulled in through `drizzle-kit`'s `@esbuild-kit` loader. drizzle-kit is a dev-only CLI and does not
  run an esbuild dev server, so the advisory does not apply. `npm audit fix --force` would downgrade
  drizzle-kit to 0.18, so it is intentionally not applied.
- TypeScript is pinned to 6.0.x because typescript-eslint does not support TypeScript 7 yet.
- The frontend bundle is ~620 kB (177 kB gzipped), mostly React and supabase-js; Vite warns above
  500 kB. Code splitting is part of the Phase 9 performance audit.
- Only the open conversation streams live. The conversation list catches up when the browser tab
  becomes visible again; a per-user channel for live list updates and unread counts belongs to
  Phase 5.
- The composer grows with its text in browsers that support `field-sizing: content`; elsewhere it
  stays one line tall and scrolls.
- Access tokens stay valid until they expire (default 1 hour) even after logout; logout revokes the
  refresh token.
