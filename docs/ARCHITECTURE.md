# Architecture

Linka is a **modular monolith**: one frontend, one API, one database, with clear boundaries between
modules so parts can be split out later if real load requires it. See [PLAN.md](../PLAN.md) for the
full plan.

## Packages

```text
@linka/frontend ──┐
                  ├──> @linka/shared (Zod schemas + types)
@linka/backend  ──┘
```

`@linka/shared` holds the contracts between frontend and backend (request/response schemas, error
codes). It is compiled to `shared/dist` with `tsc`; the root scripts always build it first.

## Request flow

```text
React component
  -> hook            (state: loading / success / error)
  -> service         (one function per API operation)
  -> lib/api.ts      (fetch + response validation with Zod, one ApiError type)
  -> Express route   (thin: parse input, call service)
  -> service         (business logic)
  -> db (Drizzle)    -> PostgreSQL
```

Example in Phase 1: `Home` -> `useHealth()` -> `services/health.ts` -> `GET /api/health` ->
`routes/health.ts` -> `services/health.ts` (`select 1`).

## Authentication (Phase 2)

```text
Browser ──(email + password)──> Supabase Auth          (sign up, log in, reset, refresh)
Browser ──(Authorization: Bearer <access token>)──> Express API
Express ──(verify signature with the project's PUBLIC keys, cached)──> JWKS
```

- The browser talks to Supabase Auth directly (`frontend/src/services/auth.ts`). There are no
  `/api/auth/*` proxy endpoints.
- supabase-js keeps the session in `localStorage` and refreshes the access token before it expires.
  `AuthProvider` mirrors its auth events (`INITIAL_SESSION`, `SIGNED_IN`, `TOKEN_REFRESHED`,
  `SIGNED_OUT`, `PASSWORD_RECOVERY`) into React state.
- `lib/api.ts` attaches the current access token to requests made with `{ auth: true }`.
- The API's `requireAuth` middleware verifies every token with `jose`: signature (ES256/RS256 via
  `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`), issuer, audience `authenticated`, expiry,
  `role = authenticated`, not anonymous, and a UUID subject. **The user ID always comes from the
  verified token**, never from the request body or URL.
- Key fetch failures answer 503 (try again), invalid tokens answer 401.

**Routes (frontend).** Signed-out: `/login`, `/register`, `/forgot-password`. From the reset email:
`/reset-password`. Signed-in: `/onboarding` (choose a username), `/` (chats), `/conversations/new`
(find someone by username), `/conversations/:conversationId`, `/profile`. Public: `/status`, 404.
Desktop shows the conversation list beside the open conversation; mobile shows one at a time.

**Profiles.** After the first login, users without a profile are sent to `/onboarding` to pick a
username and display name (`POST /api/users/me`). Usernames are chosen there rather than at sign-up
because, with email confirmation on, sign-up returns no session, and a taken username would otherwise
surface as a confusing sign-up failure.

**Privacy model.** A user can read and change only their own full profile. Since Phase 3 the API
also shows other users' *public* fields (`id`, `username`, `displayName`, `avatarPath`) in two
places: to fellow members of a conversation, and in username search. Direct database access (RLS)
still allows reading only your own profile row. Email addresses stay in Supabase `auth.users`, are
never copied into `profiles` and are never returned for other users.

**Known limitation.** Access tokens are stateless: after logout or account deletion, an already
issued access token stays valid until it expires (Supabase default: 1 hour). Logout revokes the
refresh token, so it cannot be renewed.

## Backend (`backend/src`)

| Folder / file          | Responsibility                                                      |
| ---------------------- | ------------------------------------------------------------------- |
| `server.ts`            | Starts the HTTP server, graceful shutdown                           |
| `app.ts`               | Builds the Express app (no `listen`), so tests can use it directly |
| `config/`              | Loads and validates environment variables with Zod (fails fast)     |
| `middleware/`          | Cross-cutting concerns: `requireAuth`, 404 handler, error handler   |
| `routes/`              | URL -> handler mapping. Kept thin (`health`, `users`, `conversations`) |
| `services/`            | Business logic: `auth` (tokens), `profiles`, `conversations`, `membership`, `conversationPermissions`, `messages`, `calls`, `health` |
| `validation/`          | `parseBody`: shared Zod schema -> parsed data or 400 with field errors |
| `db/`                  | Drizzle client, schema and migrations                               |
| `utils/`               | Small helpers (`AppError`)                                          |
| `test/`                | Test-only helpers: in-memory Postgres (PGlite), signed test tokens  |

`controllers/` from PLAN.md is created if route handlers grow beyond a few lines.

**API: users.** All require `Authorization: Bearer <access token>` and act on the caller only.

| Method | Path            | Body                          | Result                                    |
| ------ | --------------- | ----------------------------- | ----------------------------------------- |
| GET    | `/api/users/me` |                               | 200 profile, 404 `PROFILE_NOT_FOUND`      |
| POST   | `/api/users/me` | `{ username, displayName }`   | 201 profile, 409 `USERNAME_TAKEN` / `PROFILE_EXISTS` |
| PATCH  | `/api/users/me` | `{ displayName }`             | 200 profile, 404 `PROFILE_NOT_FOUND`      |
| GET    | `/api/users/search?q=` |                        | 200 `{ users }`: username prefix (2+ chars), case-insensitive, max 20, excludes you, public fields only |

**API (Phase 3): conversations.** All require a token. `:conversationId` and `:userId` are UUIDs.

| Method | Path                                            | Body                                   | Who                    |
| ------ | ----------------------------------------------- | -------------------------------------- | ---------------------- |
| GET    | `/api/conversations`                            |                                        | Your 50 most recently updated |
| POST   | `/api/conversations`                            | `{ type: 'direct', userId }` or `{ type: 'group', name, memberIds }` | Any signed-in user; creator becomes owner (groups) |
| GET    | `/api/conversations/:conversationId`            |                                        | Members                |
| PATCH  | `/api/conversations/:conversationId`            | `{ name }`                             | Group owner, admins    |
| POST   | `/api/conversations/:conversationId/members`    | `{ userIds }`                          | Group owner, admins    |
| PATCH  | `/api/conversations/:conversationId/members/:userId` | `{ role }` (`owner` = transfer)   | Group owner            |
| DELETE | `/api/conversations/:conversationId/members/:userId` |                                   | See role rules; your own id = leave |

- `POST` a 1:1 conversation that already exists returns it with **200** instead of creating a
  duplicate (201 when created). Both orders of the two users map to the same conversation.
- Non-members always get **404 `CONVERSATION_NOT_FOUND`**, the same answer as for a conversation
  that does not exist, so the API never confirms which conversations exist. Members without the
  required role get **403 `FORBIDDEN`**.
- Conversations include their members with public profile fields only.

Bodies are strict: unknown fields (for example `id`, `createdBy`, `senderId`) are rejected with 400
`VALIDATION_FAILED`. Responses are `Cache-Control: private, no-store`.

**Role rules (groups).** Defined once in `services/conversationPermissions.ts`:

| Action                       | owner                          | admin           | member |
| ---------------------------- | ------------------------------ | --------------- | ------ |
| Read, send messages          | yes                            | yes             | yes    |
| Rename the group             | yes                            | yes             | no     |
| Add members                  | yes                            | yes             | no     |
| Remove a regular member      | yes                            | yes             | no     |
| Remove an admin              | yes                            | no              | no     |
| Promote / demote / transfer  | yes                            | no              | no     |
| Leave                        | only after transferring ownership | yes          | yes    |

Nobody can remove or demote the owner; ownership moves only by transfer (the old owner becomes an
admin). 1:1 conversations have no roles to manage and cannot be left or changed.

**Authorization is centralized.** Every operation inside a conversation goes through
`requireMembership()` (404 for non-members) and then the role rules above. The message and call
services (`services/messages.ts`, `services/calls.ts`) use the same check. Calls have no routes
yet (calling phases).

**API (Phase 4): messages.**

| Method | Path                                              | Body / query                     | Result |
| ------ | ------------------------------------------------- | -------------------------------- | ------ |
| GET    | `/api/conversations/:conversationId/messages`     | `?limit=1..100` (default 50), `?before=<cursor>` | 200 `{ messages, nextCursor }`, messages oldest first |
| POST   | `/api/conversations/:conversationId/messages`     | `{ content, clientId }`          | 201 message; 200 with the original if `clientId` was already used |

Members only (non-members: 404). The sender is always the token's user; `senderId` in the body is
rejected. Content is stored exactly as typed: not empty, not whitespace-only, at most 4000
characters. Invalid `limit` or `before` answers 400 with a field error.

**Limits.** Groups have at most 100 members (bounded member lists and realtime fan-out).
Conversation lists return the 50 most recently active (`GET /api/conversations` is structured so a
cursor can be added later).

## Messaging and realtime (Phase 4)

### Sending a message

```text
Composer (validates with the shared schema)
  -> useConversationMessages: shows it as "Sending…" (pending, keyed by a new clientId)
  -> POST /api/conversations/:id/messages { content, clientId }
  -> API: verify token, require membership, insert (sender = token user), bump conversation activity
  -> PostgreSQL AFTER INSERT trigger -> realtime.send(..., 'message.created', 'conversation:<id>', private)
  -> API response: the stored message replaces the pending one (matched by clientId)
  -> Supabase Realtime delivers the event to members who have that conversation open
```

The **API is the only write path**; the database, not the API process, publishes the realtime
event, in the same transaction as the insert. A message that rolls back is never broadcast, and a
realtime failure is caught in the trigger so it can never block storing a message.

### Why Broadcast from Database (not Postgres Changes)

Both were compared before building (see the Phase 4 decision). Broadcast was chosen because:

- One **private channel per conversation** fits "subscribe only to what is open"; the same channel
  and authorization can carry typing, presence and read events in Phase 5 instead of adding a
  second mechanism.
- We control the payload: it is exactly the shared `Message` contract, no table internals.
- Each event is sent once and fanned out, instead of one RLS check per subscriber per change.
- Atomic with the insert (above).

Tradeoffs accepted: more SQL in Supabase's `realtime` schema, a dashboard setting (private-only
Realtime), and channel access that is cached per connection (below).

### Realtime authorization

- Channel: `conversation:<conversationId>`, `private: true`, event `message.created`.
- Joining is authorized by RLS on `realtime.messages`: policy
  `linka_conversation_members_receive_broadcasts` allows `SELECT` for `authenticated` users only
  when `private.can_access_conversation_topic(realtime.topic())` is true: the topic must be
  exactly `conversation:<uuid>` and the user a member (`private.is_conversation_member`).
  Malformed or unknown topics are denied.
- There is **no INSERT policy**, so browser clients cannot publish on these channels; every
  `message.created` comes from the database trigger. The client also validates each payload
  against the `Message` schema and ignores events for other conversations.
- **Known limitation (accepted):** Supabase checks channel access when the channel is joined and
  caches it for the connection until the access token is refreshed (Supabase's default token
  lifetime is 1 hour). A member removed from a group while their channel is open can keep receiving
  new `message.created` events until then. They can no longer read history or send: the API checks
  membership on every request, and a rejoin is refused.

### Client behavior

- **Subscriptions:** `useConversationMessages` joins the channel of the open conversation only,
  after its first page loaded, and leaves it when the conversation closes or changes. No global
  channel, no subscriptions for conversations in the list.
- **Identity and order:** the message id is the identity. Every source (history pages, send
  responses, realtime events, refetches) goes through `mergeMessages`, which deduplicates by id and
  sorts by `(createdAt, id)`, never by arrival order. The user's own message, arriving both as the
  API response and as its realtime echo (in either order), shows once; the pending copy is removed
  when a message with its `clientId` arrives from any source.
- **Retries:** a failed send stays in the list as "Not sent" with Retry. Retrying reuses the same
  `clientId`, and the database's unique `(sender_id, client_id)` index makes the server return the
  original message instead of storing a second one, even if the first attempt actually succeeded.
- **Status:** `connecting` -> `live` -> `reconnecting` (on `CHANNEL_ERROR`, `TIMED_OUT`, or an
  unexpected `CLOSED`). supabase-js retries joining by itself. While reconnecting, the view shows a
  plain notice ("Reconnecting… You can still send messages."); history stays readable and sending
  still works through the API. No page reload is needed.
- **Catching up:** events sent while not joined are not replayed, so on **every** join (including
  the first) the newest page is refetched and merged by id. If that page does not overlap what is
  shown (more than a page was missed), the view restarts from the newest page instead of showing a
  gap; older messages remain reachable with "Load earlier messages".
- **Conversation list:** updated from what this tab sees (its own sends and the open conversation's
  live messages) and refreshed when the browser tab becomes visible again. Other conversations do
  not stream live yet.

### Message pagination

- Order: `(created_at, id)`, newest page first, each page returned oldest-to-newest.
- Cursor: `base64url(JSON.stringify([createdAt, id]))` of the oldest message on the page, issued as
  `nextCursor`; `null` when there is nothing older. Clients treat it as opaque.
- Query: `WHERE conversation_id = $1 AND (created_at, id) < ($cursorTime, $cursorId) ORDER BY
  created_at DESC, id DESC LIMIT limit + 1` (the extra row tells whether an older page exists). The
  row-value comparison keeps ties on `created_at` stable and walks the
  `(conversation_id, created_at, id)` index backwards. No offsets.
- `created_at` is stored with millisecond precision so the cursor's timestamp (a JavaScript date)
  matches the stored value exactly; with microseconds, a cursor could repeat or skip messages
  created within the same millisecond.
- A cursor only positions within a conversation the caller may read: membership is checked first.

**Errors.** Throw `AppError(status, code, message)` for errors the client may see. Anything else
becomes a generic `500 INTERNAL_ERROR`; the details are logged on the server only. All errors use the
shared shape `{ "error": { "code": "...", "message": "..." } }`.

**Security baseline (Phase 1).** `helmet` security headers, CORS restricted to `CORS_ORIGIN`, JSON body
limit of 100 kB, no stack traces in responses. Token verification arrived in Phase 2; rate limiting
is part of the Phase 9 audit (Supabase Auth applies its own rate limits to sign-in and emails).

## Frontend (`frontend/src`)

| Folder       | Responsibility                                              |
| ------------ | ----------------------------------------------------------- |
| `pages/`     | Route-level screens (`Chats` layout, `Chat`, `NewChat`, profile, auth) |
| `components/`| `ui/` primitives, `layout/` shell and error boundary, feature folders |
| `hooks/`     | State + side effects for components                         |
| `services/`  | API / Supabase calls, one function per operation            |
| `lib/`       | Infrastructure: env validation, API client, Supabase client |
| `test/`      | Test setup and helpers                                      |

**Styling.** Tailwind CSS v4 with semantic color tokens defined in `src/index.css` (`canvas`, `ink`,
`accent`, ...). Dark mode follows the operating system (`prefers-color-scheme`). One accent color
(teal). Radius system: controls `rounded-lg`, panels and message bubbles `rounded-xl`, avatars
`rounded-full`. Your own messages use the accent with full-contrast text; others use the surface.

**Forms.** Validated with the same Zod schemas the API uses (`@linka/shared`). Labels sit above
inputs, errors below (linked with `aria-describedby`), form-level messages use `Alert`.

**Motion.** Kept minimal and functional: button hover/press feedback only, disabled under
`prefers-reduced-motion`. Loading placeholders are static (no looping animation). New messages
appear without animation: they arrive constantly, so motion there would be noise.

**Chat accessibility.** The message list is a `role="log"` region (new messages are announced
politely); the composer has a label; Enter sends and Shift+Enter adds a line (not while an input
method is composing); failed sends and the reconnecting notice are announced.

## Environment and secrets

- `frontend/.env` contains only public values (`VITE_` prefix). `lib/env.ts` rejects Supabase secret
  keys (`sb_secret_...` or legacy `service_role` JWTs) at startup.
- `backend/.env` contains server-only values. Only variable *names* are ever printed when validation
  fails, never values.
- Tests never read real `.env` files (Vite `envDir: false` in test mode; backend tests set their own
  variables), so they cannot hit real services.

## Deployment target (Phase 10)

```text
React (Vercel) -> Express API (Render) -> Supabase (Auth, PostgreSQL, Realtime, Storage)
```

Notes collected so far:

- Render needs the Supabase **session pooler** connection string (the direct connection is IPv6 only).
- Render's free tier sleeps when idle; the first request after that can take ~50 s.
- `GET /api/health` always returns 200 while the process is up, so a database outage does not make
  Render restart a healthy API. The body reports `status: "degraded"` instead.
- `VITE_API_URL` must be set on Vercel; it defaults to `http://localhost:3000` otherwise.
- Vercel needs an SPA rewrite so deep links (e.g. `/chats/123`) serve `index.html`.
