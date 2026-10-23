# Development status

| Phase | Name                                   | Status      |
| ----- | -------------------------------------- | ----------- |
| 1     | Foundation                             | Complete    |
| 2     | Authentication & user foundation       | Complete    |
| 3     | Database & conversation foundation     | Complete    |
| 4     | Realtime messaging                     | Complete    |
| 5     | Read, delivery, presence & typing      | Complete    |
| 6     | Media & file sharing                   | Complete    |
| 7     | Voice calls                            | In review   |
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

## Phase 5: Read, delivery, presence & typing

Done:

- Delivery and read markers on `conversation_members` (no receipt rows): batched
  `POST /api/conversations/delivered`, `PUT /api/conversations/:id/read`; never backwards, never
  past the newest message, always the caller's own row
- Read receipts: Sent / Delivered / Read (1:1), Read by N (groups), live via `receipt.updated`
- Server-authoritative unread counts in the conversation list (capped at 100), live adjustments
- Live conversation list over one private `user:<id>` channel (activity, read, added/removed/updated)
- Presence (Realtime Presence on `live:<id>`, nothing stored) and "Last seen"
  (`profiles.last_seen_at`, at most one write per minute)
- Typing indicators (Broadcast on `live:<id>`, throttled to 2 s, expire after 3 s, never stored)
- Migrations `0005` (last seen, millisecond markers) and `0006` (event triggers, user and live channel
  policies); see [DATABASE.md](DATABASE.md) and [ARCHITECTURE.md](ARCHITECTURE.md#live-state-phase-5-receipts-unread-counts-live-list-presence-typing)
- Tests: markers (auth, membership, backwards, ahead, malformed, other members), unread counts,
  last seen, triggers and payloads, user/live/conversation channel authorization, failure safety;
  client receipts, delivery batching, read tracking, live list (dedupe, own messages, read, removal,
  reconnect), presence, typing (throttle, expiry, several people, disconnect, leaving)

Not in this phase (by design): attachments, avatars, calls, push notifications, editing/deleting
messages, reactions, search beyond usernames, privacy settings for receipts or last seen.

Not verifiable until a Supabase project exists:

- Real Presence (sync, join/leave across browsers) and client broadcasts on `live:<id>`
- The `user:<id>` channel and all Phase 5 triggers on hosted Supabase
- Hosted enforcement of the new `realtime.messages` policies
- The chat UI in a real browser, including desktop, mobile and narrow layouts (behind sign-in;
  exercised through component tests only)

## Phase 6: Files & media

Done:

- Two private Supabase Storage buckets (`attachments`, `avatars`) created by migration `0008`;
  no browser policies, signed URLs only; the API is the only Storage client (server-only
  `SUPABASE_SECRET_KEY`); see [ARCHITECTURE.md](ARCHITECTURE.md#files-and-media-phase-6)
- Image and file attachments: JPEG/PNG/GIF/WebP up to 10 MB; PDF, text, ZIP, DOCX/XLSX/PPTX up to
  25 MB; at most 10 per message; captions optional
- Upload lifecycle: start (pending row + signed upload URL) -> direct browser PUT with progress
  -> complete (server checks size, stored type and the file's real signature; rejects and deletes
  otherwise) -> linked on send in one locked transaction; idempotent retries via `clientId`;
  cancel deletes; a sweep removes unsent uploads after 24 hours
- Short-lived signed download URLs, only for what the caller may see, batched (one request per
  page), cached and refreshed before expiry, cleared on sign-out
- Messages and realtime: `attachment` messages, attachments in history, sends, `message.created`
  and `conversation.activity` (triggers deferred to commit); list previews ("Photo", "3 photos",
  file name); ordering, pagination, unread counts and markers unchanged
- Profile pictures: upload / replace / remove (JPEG/PNG/WebP, 2 MB, signature-checked), signed
  `avatarUrl` on every user the API returns; avatars in the list, chat header, search and profile
- Fixed (found by an intermittent test): a message sent or received while the conversation list
  was still loading was missing from that list's preview; it is now applied once the list arrives
  (preview and order only; unread counts stay server-authoritative)
- Migrations `0007` (upload columns, constraints, indexes, enums, pending-upload RLS) and `0008`
  (payload helper, deferred triggers, buckets); see [DATABASE.md](DATABASE.md)
- Tests: upload API (auth, membership, types, extensions, sizes, empty files, path traversal and
  spoofed fields, retries, mismatched content and size, incomplete uploads, cancel, sending with
  other users', other conversations', pending and already-sent attachments, races, signed URLs for
  members only, leaving a group, storage failures), avatars (types, SVG, spoofed content, size,
  replace, remove, URLs in search and members), database (private buckets with the right limits,
  RLS for unsent uploads, path/type/size/link constraints, cascade, payloads with attachments),
  file signatures, the Storage gateway (bounded range read, generic 503s, batch signing, no
  overwrite); client validation, direct upload (progress, errors, abort), URL cache (batching,
  expiry, failures, sign-out), composer (progress, send gating, captions, attachment-only, limits,
  cancel, retry with the same clientId, rejected files, cleanup on leave), rendering (images,
  downloads, unavailable files, broken-image retry, list preview), avatar editor; mutation checks
  on the backend and the frontend

Not in this phase (by design): calls, push notifications, video or audio messages, image
resizing/thumbnails, virus scanning, editing or deleting messages and attachments, a media gallery.

Not verifiable until a Supabase project exists:

- Real uploads: signed upload URLs, the browser PUT (including CORS from the app's origin) and
  progress against Supabase Storage
- `info()`, the Range read and signed URL behavior (including the `download` flag) on hosted Storage
- Bucket creation by migration `0008` on hosted Supabase, and the bucket limits being enforced there
- Deferred triggers and payloads with attachments on hosted Supabase (tested on PGlite)
- The upload UI in a real browser (behind sign-in; exercised through component tests only)

## Phase 7: Voice calls

Done:

- 1:1 voice calls over WebRTC: start, incoming call (announced, accept / decline), calling,
  connecting, connected (duration, mute / unmute, "is muted"), reconnecting, end, and why it ended
  (declined, no answer, missed, cancelled, connection lost, continued in another tab)
- Server-authoritative lifecycle in the API with race-safe, repeatable transitions, busy and
  in-progress checks, ring timeout, heartbeats and a stale-call sweep; see
  [ARCHITECTURE.md](ARCHITECTURE.md#voice-calls-phase-7)
- `call.updated` on each participant's user channel (database trigger), so calls ring on every
  signed-in page; the conversation list and calls now live in a signed-in layout above all pages
- Signaling on a private per-call channel (`call:<id>`) only the participants can join, only while
  the call rings or is active; per-tab sessions and per-connection ids so reloads, tab changes and
  crossing messages converge on one connection; batched ICE; ICE restarts; give-up after 30 s
- WebRTC isolated in `services/webrtc.ts` (no React, no API); ICE servers served by the API
  (`ICE_SERVERS`, default public STUN)
- Cleanup: microphone stopped and connection closed whenever a call ends here; a caller's page
  closing while it rings cancels the call; signing out ends it; reloaded pages can rejoin
- Migrations `0009` (heartbeat column, sweep index) and `0010` (call payload, trigger, channel
  policies); see [DATABASE.md](DATABASE.md)
- Tests: call API (auth, membership, groups refused, video refused, spoofed fields, busy, glare,
  accept/decline/end by the right person only, repeat safety, accept-vs-cancel races, two tabs
  answering, heartbeats, ring and stale expiry, ongoing list, ICE servers, 503); database (who may
  join and publish on the call channel, closed after the call, broadcast only, call.updated
  payloads equal to the API, not for heartbeats or rollbacks, published on expiry); contracts;
  config; WebRTC module (offer/answer, queued candidates, states, ICE restart, close); signaling
  protocol with two sessions on an in-memory channel (connect, ICE batching, crossing readys,
  reloaded callee and caller, ignored strangers / own tabs / old connections, mute, ICE restart,
  give-up and recovery, close); call UI (microphone first, blocked or missing microphone, busy,
  cancel, declined, no answer, connection lost, mute, remote mute, hang up and cleanup, incoming,
  decline, missed, answered in another tab, ringing after a reload and on the profile page,
  rejoin, a second call while busy); mutation checks on the backend and the frontend

Not in this phase (by design): video (Phase 8), group calls, screen sharing, a TURN relay,
ringtones and push notifications for incoming calls, call history in the conversation.

Not verifiable until a Supabase project exists:

- Real signaling over Supabase Realtime (private channel joins on `call:<id>`, message delivery
  and rate limits) and the `call.updated` trigger on hosted Supabase
- Real WebRTC between two browsers and networks: ICE gathering, STUN, NAT traversal, audio
  quality, echo cancellation, device changes, autoplay and permission prompts (none of this can be
  reliably unit-tested; it was exercised with stand-ins only)

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
   For Phase 5, in the same two browsers check: the receiver's list shows the unread badge and new
   preview without a reload; the sender sees "Delivered" and then "Read" after the receiver opens
   the conversation; "Online" while both have it open; "typing…" while one types.

10. **Storage (Phase 6).** After `npm run db:migrate`, open *Storage*: buckets `attachments` and
    `avatars` must exist and both must show as **private** (not public). Do not make them public and
    do not add policies for them under *Storage > Policies*: the API signs every URL.
11. **Server-only Storage key.** *Project Settings > API Keys*: create or copy a **secret** key
    (`sb_secret_...`) -> `backend/.env` `SUPABASE_SECRET_KEY`, and on Render as an environment
    variable of the API service. Never in `frontend/.env`, Vercel, the browser, logs or Git. Without
    it the API starts, but uploads and profile pictures answer 503 and the API warns at startup.
12. **Check uploads** in two browsers signed in as two members of one conversation: send a photo
    with a caption and a PDF; both should appear live in the other browser, the photo should open
    full size and the PDF should download under its name. Try a file over the limit (refused before
    upload), cancel an upload midway, and set a profile picture (it should appear in the other
    browser after a reload). If the browser's upload PUT fails with a CORS error, check Storage's
    allowed origins for the project.

13. **Check calls (Phase 7)** with two browsers signed in as the two members of a 1:1
    conversation, ideally on two different networks (for example Wi-Fi and a phone hotspot): call,
    accept, talk, mute, end; call and decline; call and let it ring out; reload one side during a
    call and use **Join here**; turn one side's network off for a few seconds (it should show
    "Reconnecting…" and recover). If calls connect on one network but not across networks, a TURN
    relay is needed (not configured yet). No dashboard change is needed for calls: the channel
    policies come with the migrations, and private channels must stay required (step 8).

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
| Profile pictures | Private `avatars` bucket; uploaded through the API (2 MB raw body, signature-checked); new random path per upload; signed `avatarUrl` (1 h) on every user the API returns |
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
| Read/delivery state | Two markers per member; client-coalesced; never backwards; never past the newest message |
| Delivery trigger | Any receipt of someone else's message by the client (list, user channel, history, realtime) |
| Read trigger | Conversation open, tab visible, newest messages in view |
| Receipts | 1:1 Sent/Delivered/Read; groups "Read by N" (count only); members' markers visible to fellow members |
| Unread counts | Server-computed per conversation, capped at 100; live adjustments idempotent per message id |
| Live list | One `user:<id>` channel per signed-in user (only that user may join) |
| Channels per user | At most 4: user (on every signed-in page), the open conversation's server and live channels, and a call's channel during a call |
| Typing/presence channel | Separate member-writable `live:<id>`, so server events cannot be forged |
| Presence scope | The open conversation only; no global directory |
| Last seen | `profiles.last_seen_at`; on start, every 5 min while visible, on hide; at most 1 write/min; fellow members only |
| Typing | Throttle 2 s, expiry 3 s, never stored |
| Enums | Postgres enums built from the shared Zod value lists |
| Realtime messaging | Postgres Changes vs Broadcast tradeoff presented before Phase 4 |
| TURN | Not configured (Phase 7): STUN only, from the API's `ICE_SERVERS`. A hosted TURN provider with short-lived credentials when needed (Phase 10) |
| Calls | 1:1 voice only; the API owns the lifecycle; WebRTC carries the audio browser to browser |
| Call signaling | Private `call:<id>` channel for the participants while ringing or active; the caller always offers; per-tab sessions and per-connection ids |
| Call state to clients | `call.updated` on each participant's user channel (database trigger), plus `GET /api/calls/ongoing` after reconnects |
| Call timing | Ring 45 s (server fallback 60 s); heartbeat 20 s; active call without heartbeat ended after 60 s; give-up after 30 s without a connection |
| Busy | One call per person: starting while you or they are ringing or in a call answers `USER_BUSY` |
| Microphone | Requested before ringing anyone; stopped as soon as the call ends in that tab |
| Signed-in layout | Conversation list and calls moved above all signed-in pages (so calls ring everywhere) |
| File storage | Two private Supabase Storage buckets; no browser policies; only the API (secret key) touches Storage |
| Attachment uploads | Browser PUTs directly to a single-use signed upload URL (no file bytes through the API); the API verifies afterwards |
| File type trust | Never the client's MIME type alone: the declared type must match the extension, the stored type and the file signature |
| Allowed files | JPEG, PNG, GIF, WebP (10 MB); PDF, text, ZIP, DOCX, XLSX, PPTX (25 MB); no SVG or HTML; 10 per message |
| Storage paths | Server-chosen `<conversation>/<uploader>/<attachment>.<ext>`, pinned by a CHECK; never exposed |
| Download URLs | Signed per request: 10 min (attachments), 1 h (avatars); members only, and unsent uploads only for their uploader |
| Unsent uploads | Deleted on cancel and when leaving the conversation; swept by the API after 24 h |
| Attachments in realtime | Message triggers deferred to commit so payloads include attachments; metadata only, no URLs |

## Known issues / notes

- `npm audit` reports 4 moderate findings, all one esbuild dev-server advisory (GHSA-67mh-4wv8-2f99)
  pulled in through `drizzle-kit`'s `@esbuild-kit` loader. drizzle-kit is a dev-only CLI and does not
  run an esbuild dev server, so the advisory does not apply. `npm audit fix --force` would downgrade
  drizzle-kit to 0.18, so it is intentionally not applied.
- TypeScript is pinned to 6.0.x because typescript-eslint does not support TypeScript 7 yet.
- The frontend bundle is ~632 kB (180 kB gzipped), mostly React and supabase-js; Vite warns above
  500 kB. Code splitting is part of the Phase 9 performance audit.
- "Online" means the person has the same conversation open (Presence on that conversation's live
  channel). Otherwise the header shows "Last seen", which can lag by up to about 5 minutes.
- Supabase does not attest who sent a client broadcast or presence entry: a member could make
  another member appear typing or online in their shared conversation. Outsiders cannot, and no
  stored data is affected. Messages, receipts and list events are database-published and cannot be
  forged this way.
- Each new message writes one row to Supabase's `realtime.messages` log per member (for the live
  list), bounded by the 100-member group limit and pruned by Supabase after about 3 days.
- Unread counts above 100 show as "99+" (counting stops at 100 on purpose).
- The composer grows with its text in browsers that support `field-sizing: content`; elsewhere it
  stays one line tall and scrolls.
- Signed download URLs cannot be revoked: someone who was a member can keep using a URL they already
  received for up to 10 minutes (avatars 1 hour) after leaving. New URLs are refused at once.
- Avatar URLs in an open page expire after an hour; the picture then falls back to the initial
  until the data is fetched again (reopening the conversation or reloading).
- Uploads are checked by size, type and file signature, not scanned for malware, and images are not
  re-encoded or resized (no thumbnails yet; Phase 9 performance work).
- If an upload's start request is cancelled while still in flight, the server may already have
  created the pending row; the 24-hour sweep removes it.
- The sweep runs inside the API process (every 30 minutes). On Render's free tier the process sleeps
  when idle, so cleanup happens after it wakes. A dedicated scheduled job is a Phase 10 option.
- Backend tests run with at most 4 Vitest workers: each test file migrates its own in-memory
  Postgres, and ~16 at once starve each other past the setup timeout.
- Calls need a direct path between the two browsers (STUN only). Some networks (symmetric NATs,
  strict corporate firewalls) block that; without a TURN relay such calls stay on "Connecting…" and
  end after 30 s.
- There is no ringtone or system notification for incoming calls: the call panel and a
  screen-reader announcement only, and only while Linka is open in a tab.
- Two people ringing a third person at the same moment can both get through the busy check; the
  third person's app then shows the first call and ignores the second, which rings out ("no answer").
- Supabase does not attest the sender of call signals. Only the call's two participants can publish
  on its channel, so a participant could only disrupt their own call.
- An active call whose two tabs both vanish ends after up to 60 s (heartbeat); a reloaded page has
  about 30 s to rejoin before the other side gives up.
- Access tokens stay valid until they expire (default 1 hour) even after logout; logout revokes the
  refresh token.
