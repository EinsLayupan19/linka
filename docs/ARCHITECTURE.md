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
also shows other users' *public* fields (`id`, `username`, `displayName`, and since Phase 6 a signed `avatarUrl`) in two
places: to fellow members of a conversation, and in username search. Direct database access (RLS)
still allows reading only your own profile row. Email addresses stay in Supabase `auth.users`, are
never copied into `profiles` and are never returned for other users.

**Known limitation.** Access tokens are stateless: after logout or account deletion, an already
issued access token stays valid until it expires (Supabase default: 1 hour). Logout revokes the
refresh token, so it cannot be renewed.

## Backend (`backend/src`)

| Folder / file          | Responsibility                                                      |
| ---------------------- | ------------------------------------------------------------------- |
| `server.ts`            | Starts the HTTP server, the unsent-upload and stale-call sweeps, graceful shutdown |
| `app.ts`               | Builds the Express app (no `listen`), so tests can use it directly |
| `config/`              | Loads and validates environment variables with Zod (fails fast)     |
| `middleware/`          | Cross-cutting concerns: `requireAuth`, 404 handler, error handler   |
| `routes/`              | URL -> handler mapping. Kept thin (`health`, `users`, `conversations`, `attachments`, `calls`) |
| `services/`            | Business logic: `auth` (tokens), `profiles`, `conversations`, `membership`, `conversationPermissions`, `messages`, `markers`, `attachments`, `storage` (the only Storage client), `media` (avatar URLs), `calls` (call lifecycle), `health` |
| `validation/`          | `parseBody`: shared Zod schema -> parsed data or 400 with field errors |
| `db/`                  | Drizzle client, schema and migrations                               |
| `utils/`               | Small helpers (`AppError`, `cursor`, `fileSignature`)               |
| `test/`                | Test-only helpers: in-memory Postgres (PGlite), signed test tokens, in-memory Storage |

`controllers/` from PLAN.md is created if route handlers grow beyond a few lines.

**API: users.** All require `Authorization: Bearer <access token>` and act on the caller only.

| Method | Path            | Body                          | Result                                    |
| ------ | --------------- | ----------------------------- | ----------------------------------------- |
| GET    | `/api/users/me` |                               | 200 profile, 404 `PROFILE_NOT_FOUND`      |
| POST   | `/api/users/me` | `{ username, displayName }`   | 201 profile, 409 `USERNAME_TAKEN` / `PROFILE_EXISTS` |
| PATCH  | `/api/users/me` | `{ displayName }`             | 200 profile, 404 `PROFILE_NOT_FOUND`      |
| GET    | `/api/users/search?q=` |                        | 200 `{ users }`: username prefix (2+ chars), case-insensitive, max 20, excludes you, public fields only |
| PUT    | `/api/users/me/avatar` | the image (JPEG/PNG/WebP, max 2 MB), `Content-Type` = its type | 200 profile; 415 type, 413 size, 422 content does not match, 503 storage not configured |
| DELETE | `/api/users/me/avatar` |                        | 200 profile without a picture |

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
services (`services/messages.ts`, `services/calls.ts`) use the same check. Calls are described in
[Voice calls](#voice-calls-phase-7).

**API (Phase 4): messages.**

| Method | Path                                              | Body / query                     | Result |
| ------ | ------------------------------------------------- | -------------------------------- | ------ |
| GET    | `/api/conversations/:conversationId/messages`     | `?limit=1..100` (default 50), `?before=<cursor>` | 200 `{ messages, nextCursor }`, messages oldest first |
| POST   | `/api/conversations/:conversationId/messages`     | `{ clientId, content?, attachmentIds? }` (content or attachments) | 201 message; 200 with the original if `clientId` was already used |

Members only (non-members: 404). The sender is always the token's user; `senderId` in the body is
rejected. Content is stored exactly as typed: not empty, not whitespace-only, at most 4000
characters. Invalid `limit` or `before` answers 400 with a field error.

**API (Phase 6): attachments.** Members only; details in [Files and media](#files-and-media-phase-6).

| Method | Path                                              | Body                                         | Result |
| ------ | ------------------------------------------------- | -------------------------------------------- | ------ |
| POST   | `/api/conversations/:conversationId/attachments`  | `{ clientId, fileName, contentType, sizeBytes }` | 201 `{ attachment, upload: { url, expiresAt } }`; 200 for the same `clientId` |
| POST   | `/api/attachments/:attachmentId/complete`         |                                              | 200 attachment (ready); 409 `UPLOAD_INCOMPLETE`; 422 `UPLOAD_REJECTED` |
| DELETE | `/api/attachments/:attachmentId`                  |                                              | 204; 409 `ATTACHMENT_IN_USE` once sent |
| POST   | `/api/attachments/urls`                           | `{ attachmentIds }` (1-50)                   | 200 `{ urls: [{ id, url, expiresAt }] }`, only what you may see |

Someone else's upload, or a malformed id, answers 404 `ATTACHMENT_NOT_FOUND`. Storage failures
answer 503 without details.

**API (Phase 7): calls.** All require a token; `:callId` is a UUID (anything else answers 404).

| Method | Path | Body | Who / result |
| ------ | ---- | ---- | ------------ |
| POST   | `/api/calls` | `{ conversationId, type: 'voice' }` | A member of a 1:1 conversation; 201 ringing call. 400 `CALL_NOT_SUPPORTED` (group), 409 `CALL_IN_PROGRESS` / `USER_BUSY` |
| GET    | `/api/calls/ongoing` |  | 200 `{ calls }`: your ringing and active calls |
| GET    | `/api/calls/ice-servers` |  | 200 `{ iceServers }` (STUN/TURN for WebRTC) |
| GET    | `/api/calls/:callId` |  | Members of its conversation |
| POST   | `/api/calls/:callId/accept` |  | The callee; 200 active (repeatable); 403 for the caller; 409 `CALL_ENDED` |
| POST   | `/api/calls/:callId/decline` |  | The callee; 200 declined (repeatable) |
| POST   | `/api/calls/:callId/end` |  | Either participant; ends, cancels or refuses; repeatable |
| POST   | `/api/calls/:callId/heartbeat` |  | A participant; 204, or 409 `CALL_ENDED` |

Someone who is not in the call gets 404 `NOT_FOUND` (the call's existence is never revealed).

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
- **Conversation list:** live since Phase 5, through the user channel (below).

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

## Live state (Phase 5): receipts, unread counts, live list, presence, typing

### Channels

At most **four channels per signed-in user**, whatever the number of conversations:

| Topic                | Lifetime                    | Who joins          | Who publishes | Events |
| -------------------- | --------------------------- | ------------------ | ------------- | ------ |
| `user:<userId>`      | While signed in (any page, since Phase 7) | **that user only** | database only | `conversation.activity`, `conversation.read`, `conversation.changed`, `call.updated` |
| `conversation:<id>`  | While that conversation is open | members        | database only | `message.created`, `receipt.updated`, `conversation.updated` |
| `live:<id>`          | While that conversation is open | members        | members       | Presence, `typing` |
| `call:<callId>`      | During a call (Phase 7)     | that call's participants, while it rings or is active | those participants | `signal` (WebRTC) |

Every payload has a Zod contract in `@linka/shared` (`realtime/events.ts`) and is validated by the
client before use; invalid events are dropped.

**Why the open conversation has two channels.** Supabase authorizes *publishing* when a client joins
a channel (cached for the connection), not per event. If members could publish on
`conversation:<id>`, a member could inject a forged `message.created` or `receipt.updated` that
others would display. So server events stay on a database-only channel, and only the ephemeral,
low-stakes events (typing, presence) use the member-writable `live:<id>`.

### Realtime authorization

Policies on `realtime.messages` (migration `0006_live_state_events`), all for `authenticated`:

- `user:<id>`: `SELECT` (broadcast) only when the topic equals `'user:' || auth.uid()` exactly
  (`private.can_access_user_topic`). There is no pattern that admits other users, and no INSERT.
- `live:<id>`: `SELECT` and `INSERT` for broadcast and presence when the topic is exactly
  `live:<uuid>` and the user is a member (`private.can_access_live_topic`). This is the only topic
  clients may publish on.
- `conversation:<id>`: unchanged from Phase 4 (members receive broadcasts; nobody publishes;
  presence is not allowed there).
- `call:<callId>` (Phase 7, migration `0010_call_signaling`): `SELECT` and `INSERT` of broadcasts
  for that call's participants while it rings or is active (`private.can_access_call_topic`).

The client joins `live:<id>` only after the conversation loaded (membership confirmed), so it never
probes channels it may not join.

**Known limitation.** Supabase does not attest who sent a client broadcast or presence entry. A
*member* of a conversation could make another *member* appear to be typing or online in that
conversation. Outsiders cannot (they cannot join), payloads must name a current member, and neither
feature touches stored data. Message content, receipts and list events cannot be forged this way
because they are database-only.

### Read and delivery markers

- Two timestamps per member (`conversation_members.last_delivered_at`, `last_read_at`); never a row
  per message or per receipt. A message is delivered to / read by a member when its `created_at`
  is at or before that member's marker.
- **Delivered:** the client reports the newest message from someone else that it received through
  the conversation list, the user channel, a history page or `message.created`. Reports are
  coalesced by `createDeliveryReporter` (1.5 s window, newest time per conversation, nothing at or
  before what the server already has) into `POST /api/conversations/delivered` (up to 50
  conversations per request). Stale values are skipped server-side; markers never move backwards.
- **Read:** `useReadTracking` advances the marker when the conversation is open, the tab is visible
  and the newest messages are scrolled into view, and only when someone else's message is newer
  than the marker. One debounced request (`PUT /api/conversations/:id/read`); a backwards move is
  rejected with 409 `MARKER_BEHIND` (e.g. a stale tab) and treated as done. Reading also raises
  delivery.
- **Validation:** a marker can never be set later than the conversation's newest message, so nobody
  can mark future messages as read in advance. There is no `userId` anywhere in these requests: the
  marker updated is always the caller's own row.

**API (Phase 5).**

| Method | Path                                   | Body                                        | Result |
| ------ | -------------------------------------- | ------------------------------------------- | ------ |
| PUT    | `/api/conversations/:id/read`          | `{ lastReadAt }`                            | 200 markers; 409 `MARKER_BEHIND`; 400 ahead/invalid; 404 non-member |
| POST   | `/api/conversations/delivered`         | `{ conversations: [{ conversationId, lastDeliveredAt }] }` (1-50) | 200 `{ updated }`; 404 if any is not the caller's |
| POST   | `/api/users/me/seen`                   |                                             | 204 (throttled to once a minute) |

### Read receipts

Derived on the client from the other members' markers (`utils/receipts.ts`), shown under my newest
message only:

- 1:1: `Sent` -> `Delivered` (their delivery marker reached it) -> `Read` (their read marker did).
- Groups: `Read by N` (how many, not who), otherwise `Delivered` / `Sent`.

Members' markers come with the conversation (`members[].lastDeliveredAt/lastReadAt`, visible to
fellow members only, as RLS already allows) and update live from `receipt.updated`.

### Unread counts

- Server-authoritative: `unreadCount` on every conversation = other people's messages with
  `created_at > my last_read_at` (`sender_id is distinct from me`), counted in the same request for
  all listed conversations (one query; each count an index range scan on
  `(conversation_id, created_at, id)`) and capped at 100 ("99+"). No counter table.
- Live adjustments: `conversation.activity` from someone else adds 1, once per message id, and not
  for the conversation currently open; `conversation.read` resets to 0 when everything is read (or
  refetches for a partial read). Every (re)join of the user channel refetches the list, so live
  adjustments can never drift for long.

### Live conversation list

`useConversationList` subscribes to `user:<me>` once and applies `conversation.activity` (preview,
order by activity, unread), `conversation.read` and `conversation.changed` (`added`/`updated`:
refetch; `removed`: drop it). The database publishes these from triggers (fan-out to each member's
user channel, bounded by the 100-member group limit), so the API stays the only write path.

### Presence and last seen

- **Online** is Realtime Presence on `live:<id>`: each client tracks `{ userId }` while it has that
  conversation open; nothing is written to PostgreSQL. In a 1:1 header the other person shows as
  **Online** when they have this conversation open; groups show "N online". Presence is scoped to
  the conversation, not a global directory: you only ever see presence of members of the
  conversation you are viewing.
- **Last seen** (`profiles.last_seen_at`) is durable but low-write: the client reports activity on
  start, every 5 minutes while the tab is visible, and when the tab is hidden (with `keepalive`); the
  server ignores reports less than 60 seconds apart. Fellow members see it in conversation details
  ("Last seen 5 min ago"); it is not in user search. It is not updated continuously because it does
  not need to be precise and must not become a write-per-heartbeat workload.

### Typing

- Broadcast on `live:<id>`, never stored. `notifyTyping` sends `typing: true` at most every 2 s
  while keys are pressed, and `typing: false` after 3 s idle, on send, and on leaving.
- Receivers show "Jonas is typing…", "Jonas and Maria are typing…" or "3 people are typing…";
  each entry expires 3 s after its last event, and everything clears when the connection drops or
  the conversation closes. Events from yourself, non-members or other conversations are ignored.

### Reconnects

All three channels report `connecting` / `live` / `reconnecting` and rejoin on their own
(supabase-js). After every join: the user channel refetches the conversation list, the conversation
channel refetches the newest messages (Phase 4), and the live channel re-tracks presence. Typing and
presence clear while disconnected rather than showing stale state.

**Errors.** Throw `AppError(status, code, message)` for errors the client may see. Anything else
becomes a generic `500 INTERNAL_ERROR`; the details are logged on the server only. All errors use the
shared shape `{ "error": { "code": "...", "message": "..." } }`.

**Security baseline (Phase 1).** `helmet` security headers, CORS restricted to `CORS_ORIGIN`, JSON body
limit of 100 kB, no stack traces in responses. Token verification arrived in Phase 2; rate limiting
is part of the Phase 9 audit (Supabase Auth applies its own rate limits to sign-in and emails).

## Files and media (Phase 6)

### Storage layout

Two **private** Supabase Storage buckets, created by migration `0008` (never public, no
`storage.objects` policies for browser roles, so the browser cannot list, read or write them with
its own key):

| Bucket        | Holds                 | Path (chosen by the server)                      | Bucket limits                         |
| ------------- | --------------------- | ------------------------------------------------ | ------------------------------------- |
| `attachments` | Message images, files | `<conversationId>/<uploaderId>/<attachmentId>.<ext>` | 25 MB, the allowed MIME list       |
| `avatars`     | Profile pictures      | `<userId>/<random uuid>.<ext>`                   | 2 MB, JPEG / PNG / WebP               |

Only the API talks to Storage, with the server-only `SUPABASE_SECRET_KEY`
(`backend/src/services/storage.ts`). Browsers get one of two things, both short-lived and scoped
to exactly one object: a **signed upload URL** (single use, 2 hours, fixed by Supabase) or a
**signed download URL** (attachments 10 minutes, avatars 1 hour). Storage paths never appear in
API responses or realtime payloads, and are never built from client input: file names are display
metadata only. A database CHECK (`message_attachments_path_shape`) pins every path to its own
conversation, uploader and row id.

### Allowed files

| Kind   | Types                                           | Max   |
| ------ | ----------------------------------------------- | ----- |
| Images | JPEG, PNG, GIF, WebP                            | 10 MB |
| Files  | PDF, plain text, ZIP, DOCX, XLSX, PPTX          | 25 MB |
| Avatar | JPEG, PNG, WebP                                 | 2 MB  |

At most 10 attachments per message. SVG and HTML are not allowed (they can carry scripts).
The client's MIME type is never trusted on its own: after upload the server reads the first 512
bytes and checks the file signature (`backend/src/utils/fileSignature.ts`); Office files must be
ZIP containers, text must contain no NUL bytes and must not be a binary format in disguise. The
limits live in `@linka/shared` and are enforced by the browser (early, friendly errors), the API,
the database CHECKs and the bucket settings.

### Upload lifecycle

```text
1 POST /api/conversations/:id/attachments  {clientId, fileName, contentType, sizeBytes}
    member? valid? -> row (pending) + signed upload URL           (same clientId = same row)
2 browser PUTs the file to the signed URL (XHR, for progress; abortable)
3 POST /api/attachments/:id/complete
    object exists? size = declared? stored type = declared? signature matches?
      yes -> ready            no -> object and row deleted, 422 UPLOAD_REJECTED
      nothing uploaded yet -> 409 UPLOAD_INCOMPLETE (retry)
4 POST /api/conversations/:id/messages  {clientId, content?, attachmentIds}
    in one transaction: lock the caller's own ready, unsent uploads in THIS conversation
    (SELECT ... FOR UPDATE), insert the message, link them
```

- **Retries.** Every step is idempotent: starting again with the same `clientId` returns the same
  upload (with a fresh upload URL while pending); completing a ready upload returns it; sending
  again with the same message `clientId` returns the original message.
- **Cancellation.** Removing a file in the composer aborts its PUT and calls
  `DELETE /api/attachments/:id` (only the uploader, only while unsent; a sent attachment answers
  409). Leaving the conversation does the same for every unsent file.
- **Orphans.** Anything left behind (closed tab, lost network, abandoned pending rows) is removed
  by a sweep in the API process: a minute after start, then every 30 minutes, it deletes unsent
  uploads older than 24 hours. Rows are deleted first (only if still unsent, so a send racing the
  sweep either wins or fails cleanly), then their files. A file whose row is gone is harmless:
  nothing references it and nobody can get a URL for it.
- **Realtime.** The message triggers are deferred to commit (`DEFERRABLE INITIALLY DEFERRED`), so
  `message.created` and `conversation.activity` include the attachments linked in the same
  transaction. Payloads carry only `id`, `fileName`, `contentType` and `sizeBytes`.

### Viewing files

`POST /api/attachments/urls` (up to 50 ids) returns signed URLs only for attachments the caller may
see right now: member of the conversation, upload verified, and either sent or their own. Others
are silently left out (no existence leak). The client batches every URL a page needs into one
request, caches them until a minute before expiry, refreshes them while a conversation stays open,
retries a broken image once with a fresh URL, and clears the cache on sign-out. Images open full
size in a new tab, served by Storage on its own origin (never by Linka's), and files download with
Storage's `download` flag under their original name.

### Profile pictures

`PUT /api/users/me/avatar` takes the image itself as the request body (at most 2 MB, parsed only on
that route), checks type, size and signature, stores it under a new random name and then deletes
the old one; `DELETE /api/users/me/avatar` removes it. Every response that includes a user
(profile, members, search) carries a fresh signed `avatarUrl`, signed in one batch per response;
if signing fails the user simply shows their initial.

## Voice calls (Phase 7)

1:1 voice calls between the two members of a direct conversation. Group calls and video come
later (video is Phase 8; the call contract already has a `type`).

```text
Browser A ──API──> start / accept / decline / end / heartbeat      (call state, authorized, stored)
Database ──user:<id>──> call.updated to both people                (rings, answered, over)
Browser A <──call:<callId>──> Browser B   offer / answer / ICE      (signaling, participants only)
Browser A <════════ WebRTC (DTLS-SRTP) ════════> Browser B          (the audio; never via Linka)
```

### Who decides what

| Concern | Owner |
| --- | --- |
| Whether a call may start, who is in it, its state | The API (`services/calls.ts`), the only writer of `calls` / `call_participants` |
| Telling both people about state changes | A database trigger publishing `call.updated` on each participant's `user:<id>` |
| Finding each other (SDP, ICE) | The two browsers, over the call's private `call:<callId>` channel |
| Carrying audio | WebRTC, browser to browser (a TURN relay later); Express never sees media |

### Lifecycle (server-authoritative)

```text
ringing --accept (callee)----------------> active --end (either)--> ended
ringing --decline / end (callee)---------> declined
ringing --end (caller) / ring timeout----> missed
active  --no heartbeat for 60 s----------> ended
```

- **Start** (`POST /api/calls`): a member of a 1:1 conversation; refused for groups
  (`CALL_NOT_SUPPORTED`), when this conversation already has a call (`CALL_IN_PROGRESS`, which is
  also what the second person gets when both call each other at once), and when the caller or the
  callee is already ringing or in another call (`USER_BUSY`).
- **Transitions** are conditional updates (`WHERE status = 'ringing'`), so races (answer vs.
  cancel, two tabs answering) resolve to exactly one outcome; repeating a transition that already
  happened returns the call unchanged, so clients retry safely. All timestamps use the database
  clock.
- **Ring timeout**: the caller stops after 45 s (`CALL_RING_TIMEOUT_SECONDS`), the callee's
  ringing stops on its own too, and the server marks a call still ringing after 60 s missed.
- **Heartbeats**: every connected tab reports every 20 s; an active call nobody reported on for
  60 s (both tabs closed, both offline) is ended by the server, so stale calls never block new
  ones. The API applies these expiries before starting, answering or listing calls, and a sweep in
  the API process (every 30 s) applies them otherwise, so `call.updated` still reaches clients.

### Signaling (`call:<callId>`)

Private channel, joined only for the duration of the call. Only that call's participants may join
or publish, and only while it rings or is active (`private.can_access_call_topic`); broadcast only,
no presence. Messages are validated against `callSignalSchema`:

- Every browser tab in a call has a random **session**; every message carries it, and all but
  `ready`/`media` name the session they are for. Each `RTCPeerConnection` also has a
  **connection** id. So a reloaded page, a call moved to another tab, or two messages that cross
  can never mix two connections: the old session gets `bye` and stops; answers and candidates
  for an old connection are ignored.
- `ready` on every (re)join; the **caller always offers** in reply to the callee's `ready` (no
  glare); ICE candidates are trickled in batches (100 ms) to stay under Realtime's message limits.
- **Recovery**: a dropped connection shows "Reconnecting…"; after 6 s (or at once on `failed`)
  the caller does an ICE restart on the same connection (the callee asks for one with `ready`). If
  it is not connected again within 30 s, the call ends ("connection was lost").
- **Why a per-call topic** (not `live:<conversationId>`): it closes when the call ends, admits
  exactly the participants, and keeps signaling apart from typing. Supabase does not attest who
  sent a client broadcast, but on `call:<id>` the only possible senders are the two participants
  (and their own tabs, which are ignored), so a forged message can only affect a call the sender
  is already in.

### Client structure

| Module | Responsibility |
| --- | --- |
| `services/webrtc.ts` | One `RTCPeerConnection`: offer/answer, queued remote candidates, ICE restart, simplified states. No React, no Linka API |
| `services/callSession.ts` | The signaling protocol above, on top of `webrtc.ts` and `joinCallChannel` |
| `services/calls.ts`, `services/microphone.ts` | Lifecycle API calls; microphone access with readable errors |
| `hooks/useCalls.ts` | The call state machine for the whole app (one call at a time), timers, cleanup |
| `components/call/CallPanel.tsx` | Incoming / calling / connecting / in call / reconnecting / ended UI, remote audio |
| `components/layout/SignedInLayout.tsx` | Hosts the conversation list and calls for every signed-in page |

- The microphone is requested **before** ringing anyone (a blocked microphone never leaves the
  other person waiting) and stopped the moment a call ends in this tab.
- Every state change from the server goes through one `apply(call)` function, from API
  responses, `call.updated` events and `GET /api/calls/ongoing` (on start and after every
  user-channel reconnect), so missed events cannot leave a stale call on screen.
- A call answered in another tab shows "On this call in another tab" with **Join here**; a
  reloaded page in an active call shows the same and can rejoin (the audio needs the click:
  browsers block autoplay otherwise). Closing a page while our call still rings cancels it
  (`keepalive` request); an active call is not ended on close, so a reload can rejoin it.
- Mute disables the local track (no renegotiation) and tells the other side (`media`).
- **ICE servers** come from the API (`GET /api/calls/ice-servers`, server env `ICE_SERVERS`,
  default one public STUN server). No TURN relay is configured yet: calls between two networks
  that block direct connections (some corporate networks, symmetric NATs) will not connect. A TURN
  provider with short-lived credentials can be added behind the same endpoint without frontend
  changes (Phase 10 decision).

### What cannot be unit-tested

Real WebRTC (ICE gathering, NAT traversal, DTLS, audio devices, echo cancellation, autoplay
policies, browser permission prompts) and Supabase's real WebSocket delivery. Tests use a
`RTCPeerConnection` stand-in that follows the offer/answer state machine, fake media tracks, and
the Realtime stand-in; database tests check the channel policy and trigger on PGlite. Two-browser
checks on a real Supabase project are listed in DEVELOPMENT_STATUS.md.

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

**Motion.** Kept minimal and functional: button hover/press feedback and a short linear catch-up on
upload progress bars, all disabled under `prefers-reduced-motion`. Loading placeholders are static (no looping animation). New messages
appear without animation: they arrive constantly, so motion there would be noise.

**Chat accessibility.** The message list is a `role="log"` region (new messages are announced
politely); the composer has a label; Enter sends and Shift+Enter adds a line (not while an input
method is composing); failed sends and the reconnecting notice are announced.

## Environment and secrets

- `frontend/.env` contains only public values (`VITE_` prefix). `lib/env.ts` rejects Supabase secret
  keys (`sb_secret_...` or legacy `service_role` JWTs) at startup.
- `backend/.env` contains server-only values, including `SUPABASE_SECRET_KEY` (Storage access; the
  API refuses a publishable key there). Only variable *names* are ever printed when validation
  fails, never values. Storage errors are logged on the server and answered with a generic 503.
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
- Render needs `SUPABASE_SECRET_KEY` (server-only) for uploads; Vercel must never get it.
- Vercel needs an SPA rewrite so deep links (e.g. `/chats/123`) serve `index.html`.
