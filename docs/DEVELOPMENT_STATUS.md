# Development status

| Phase | Name                                   | Status      |
| ----- | -------------------------------------- | ----------- |
| 1     | Foundation                             | Complete    |
| 2     | Authentication & user foundation       | Complete    |
| 3     | Database & conversation foundation     | Complete    |
| 4     | Realtime messaging                     | Complete    |
| 5     | Read, delivery, presence & typing      | Complete    |
| 6     | Media & file sharing                   | Complete    |
| 7     | Voice calls                            | Complete    |
| 8     | Video calls                            | Complete    |
| 9     | Group chat UI                          | In review   |
| 10    | Polish, security & scalability         | In progress |
| 11    | Production preparation & deployment    | Not started |

Also done between phases: light, dark and system themes (see [Themes](#themes)).

The group chat UI was added as Phase 9 (the API for groups has existed since Phase 3); the former
Phases 9 and 10 moved to 10 and 11.

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
- Tests: call API (auth, membership, groups refused, video refused until Phase 8, spoofed fields, busy, glare,
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

## Phase 8: Video calls

Done:

- 1:1 video calls on the Phase 7 lifecycle, signaling and recovery (no new API routes or
  migrations: `POST /api/calls` now accepts `type: 'video'`; the `call_type` enum always had it)
- "Video" button next to "Call" in 1:1 chats; "Incoming video call"; remote video with your own
  camera preview; camera on / off during the call, alongside mute / unmute and end
- Camera requested separately from the microphone (a denied camera never costs the microphone):
  - caller: camera denied or missing -> "Continue with voice" (the call starts as a voice call) or
    cancel; nobody is rung until then
  - callee: camera denied -> "Accept without camera" (still a video call; turn the camera on later)
  - Join here / reload: rejoins with the camera if possible, otherwise audio only with a notice
- One two-way video line negotiated for every video call, even without a camera, so the camera can
  be turned on, off and on again with `replaceTrack` and no new offer; see
  [ARCHITECTURE.md](ARCHITECTURE.md#video-phase-8)
- Camera state (`cameraEnabled`) sent with the mute state in the `media` signal; "Camera off" shown
  instead of their video; a camera unplugged mid-call turns it off with a notice
- Fixed during review: a callee who answered without a camera could not be seen after turning the
  camera on (their video went to a transceiver that was never negotiated); once that worked, the
  caller would have lost the callee's audio (video arriving without a stream replaced the audio
  stream); and the other person's video stayed blank after they turned their camera off and on (the
  new `<video>` element never got the stream)
- Tests: contracts and API (video accepted); WebRTC module (video line for caller and callee with
  and without a camera, camera on / off / on on the negotiated line, no video in voice calls, remote
  audio and video in one stream); signaling with two sessions (callee without a camera turns it on,
  no new offer); call UI (video call start, camera preview and toggle, camera denied for caller and
  callee, rejoin with camera, their video hidden while their camera is off and shown again)

The `RTCPeerConnection` stand-in follows the browser rule that matters here (a remote offer reuses
only `addTrack` transceivers), but it carries no media: tests prove the negotiation logic, not that
video reaches the other browser.

Not in this phase (by design): group video, screen sharing, switching cameras (front / back) or
picking devices, turning a voice call into a video call, quality / resolution settings, a TURN relay,
recording.

Not verifiable until checked in two real browsers (step 14 below):

- Video actually reaching the other browser, on one network and across networks; camera
  permission prompts; camera on / off / on in both directions; mobile browsers (iOS Safari,
  Android Chrome), including autoplay rules and the panel's size on small screens

## Phase 9: Group chat UI

Done (web client only; the API, database, RLS and realtime events for groups already existed):

- **New group** (from New chat): group name, people chosen by username search (each person once;
  yourself never listed), checked with the shared schema before sending, "Creating…", the API's
  reason on failure; opens the new group
- Groups in the list: two members' faces as the group's picture (groups have no picture of their
  own), "Group" for screen readers, the sender's name in the preview ("Jonas: See you there"), time,
  unread count
- Group chat: header with the group's picture, name, "N members" (and "M online"), **Group info**;
  the existing history, composer, attachments, typing, "Read by N" and sender names; no call buttons
- **Group info** dialog (native `<dialog>`): name, member count, your role, members sorted owner,
  admins, members, with roles and "(you)"; actions only where your role allows them:
  - Rename (owner, admins), Add people (owner, admins; current members cannot be chosen again)
  - Per member: Make admin / Remove as admin and Make owner (owner only), Remove from group (owner;
    admins for regular members)
  - Leave group (admins and members; the owner is told to hand over ownership first)
  - Remove, transfer and leave ask for confirmation and say what will happen
- Changes made here update the dialog, the chat header and the list at once; changes made by others
  arrive through the existing events (`conversation.updated` refetches the open group,
  `conversation.changed` updates the list); someone who is removed sees "Conversation not found"
  and loses the group from their list
- Role rules moved from the backend to `@linka/shared` (`conversations/permissions.ts`): the API
  enforces them, the web client uses the very same functions to decide what to show
- Tests: shared permission rules (moved with them); API: a member removed from a group can no longer
  read, send or see it (new); web: creating a group (success, no name, no members, choosing the same
  person twice, "Creating…", field and network errors), the list row, the group header, the info
  dialog for a member, an admin and the owner (which actions appear), rename (success, validation,
  refused), add people (current members not choosable, none chosen, already added), remove (confirm,
  cancel, refused), transfer, make admin and back, leave, closing and reopening, live rename and new
  member, being removed by someone else

Not in this phase (by design): group pictures, group descriptions or invite links, deleting a group,
group calls, muting or archiving, per-member read receipts (groups keep "Read by N").

Not verifiable without two or more real accounts (step 15 below): the realtime updates between
browsers, and everything above against the hosted API.

## Phase 10: Polish, security & scalability

Done so far:

- **Rate limits** on the API (`middleware/rateLimit.ts`, details in ARCHITECTURE.md): per user once
  signed in (overall, and tighter ones for sending, search, new conversations, group changes,
  calls and uploads), per IP for requests without a valid token and for the health check. Over a
  limit: `429 RATE_LIMITED` with `Retry-After`; the web client shows the API's message. New env
  variable `TRUST_PROXY` (`0` locally, `1` on Render) so IPs come from `X-Forwarded-For` only
  behind a known proxy
- **Group ownership race fixed** (was a known issue): membership changes to a conversation run
  one at a time in a transaction that locks it, with every check after the lock; migration `0011`
  adds a deferred database check that a group never ends up without an owner (answered as
  `409 OWNER_CANNOT_LEAVE`). Group size is also counted under the lock, so two additions at once
  cannot pass 100 members
- **Removed members stop receiving live** (was a known issue): realtime topics carry the
  conversation's channel version (migrations `0012`, `0013`), which goes up on every leave or
  removal; members' clients rejoin the new topics after the refetch, the removed member is not
  admitted to them, and nothing is published on the old ones again
- **Code splitting**: pages other than the chats load on first visit; React, supabase-js and Zod
  in their own long-cached files. No file above 500 kB (was one 632 kB file); the Vite warning is gone
- **Accessibility**: page names in the tab and announced to screen readers on every page change;
  **Skip to content** link; visible focus outlines on every control; form field borders at 3:1
  contrast in both themes (were 1.25:1 light, 1.66:1 dark); the owner's **Leave group** is
  focusable (`aria-disabled`) so its explanation can be reached
- Tests: rate limiter (windows, keys, refusing without extending) and the API's limits end to end
  (per user, per action, overall, per IP before sign-in, header spoofing, health, and that a normal
  burst of activity is never refused); ownership invariant in the database (transfer to a removed
  member, removing or demoting the owner, complete transfers, deleting groups and accounts, 1:1) and
  the API's races (transfer vs removal, leave vs promotion, two tabs); removed members on realtime
  (version bump, last event on the old topic and nothing after, join refused on old and new topics,
  leaving, additions and renames keep the version, re-added members, malformed topics); web: rejoin
  under the new version, page titles and announcements, skip link, the focusable Leave group

Still to do in this phase: a TURN relay with short-lived credentials (behind the existing
`GET /api/calls/ice-servers`), the upload sweep as a scheduled job instead of inside the API
process, image thumbnails, and checking the above against the hosted project (step 16 below).

Not verifiable locally: the channel version against hosted Supabase Realtime (the policies are
tested on a local Postgres with Supabase's `realtime` schema stubbed), and rate limits behind
Render's proxy (`TRUST_PROXY=1`).

## Themes

Light, dark and **system** (follows the operating system, live) themes, chosen under *Profile >
Appearance* and saved in `localStorage` (`linka-theme`). A small inline script in `index.html`
applies the saved theme before the app renders, so pages never flash the wrong theme. Signed-out
pages use the saved (or system) theme; the switch itself is on the profile page only.

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

14. **Check video calls (Phase 8)** in the same two browsers (camera and microphone on both
    devices; `localhost` or HTTPS, since browsers allow cameras only on secure origins): video call,
    accept, see each other, turn each camera off and on again, mute, end. Then: deny the camera on
    the caller (expect "Continue with voice"); deny it on the callee and use "Accept without
    camera", then turn the camera on during the call (the other side should see it); reload one
    side and use **Join here**.

15. **Check groups (Phase 9)** with three accounts in three browser sessions: create a group, send
    messages (they should appear live for everyone), rename it, add and remove someone (the removed
    person's list drops the group and its page shows "Conversation not found"), make someone an
    admin, transfer ownership, and leave. No dashboard change is needed.

16. **Check Phase 10.** Apply the new migrations (`cd backend && npm run db:migrate`: `0011` to
    `0013`). Then, with the step 15 group open in three browsers:
    - Remove one person while they have the group open, then send a message from another browser:
      it must **not** appear in the removed person's browser (before Phase 10 it did), and the two
      others keep receiving messages, typing and "Online" without a reload.
    - Re-add that person: they get the group back and receive live again.
    - On Render, set `TRUST_PROXY=1` on the API service. Optionally check a limit: requests without
      a token from one machine get `429` with `Retry-After` after 60 in a minute
      (`curl -i <api>/api/users/me` in a loop), while signed-in use in the browser is unaffected.
    No Supabase dashboard change is needed.

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
| Group roles | `owner`, `admin`, `member`; rules in ARCHITECTURE.md and `@linka/shared` `conversations/permissions.ts` (used by the API to enforce, by the web client to show actions) |
| Group picture | None stored: two members' faces (others first, then you), or the name's initial |
| Group management UI | One native `<dialog>` with views (overview, rename, add, member, confirm); destructive or irreversible steps confirm first |
| Ownership | Exactly one owner; leaves only after transferring; transfer makes the old owner an admin |
| 1:1 conversations | Exactly two members, unique per pair (database), cannot be left or changed; creating an existing one returns it |
| Non-member access | 404, same as a missing conversation (existence is never revealed) |
| Conversation writes | API only; RLS is select-only on every table |
| Deleted accounts | Their messages stay with `sender_id = null`; memberships are removed |
| Message ordering | `(created_at, id)`, cursor-ready; soft delete via `deleted_at` |
| Read/delivery markers | Columns exist on `conversation_members` (PLAN.md §5), logic in Phase 5 |
| Realtime | Broadcast from Database, private channel per conversation, event `message.created`, payload = shared `Message` |
| Realtime writes | Only the database trigger publishes; no INSERT policy for clients |
| Removed members on an open channel | Cut off at once (Phase 10): topics carry `channel_version`, bumped on every leave or removal; before, they kept receiving until their token refreshed |
| Rate limits | In-process fixed one-minute windows; per user once signed in, per IP otherwise; `429 RATE_LIMITED` + `Retry-After`; IP via `TRUST_PROXY` only (Phase 10) |
| Membership change concurrency | One transaction per change, locking the conversation row first; deferred database check that a group keeps an owner (Phase 10) |
| Page loading | Chats and chat with the app; other pages lazy; React, supabase-js, Zod in separate cached files (Phase 10) |
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
| Calls | 1:1 voice and video; the API owns the lifecycle; WebRTC carries audio and video browser to browser |
| Video negotiation | Every video call negotiates one two-way video line, camera or not; the camera goes on / off with `replaceTrack`, never a new offer (only the caller offers) |
| Camera | Requested separately from (and after) the microphone; a denied camera offers voice (caller) or "Accept without camera" (callee) |
| Camera off | Sends nothing on the video line and tells the other side (`media.cameraEnabled`), which shows "Camera off" |
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
- Since Phase 10 the app loads in files of at most ~257 kB (React; 82 kB gzipped); what a first
  visit to the chats downloads is still about 180 kB gzipped, most of it React and supabase-js.
- Rate limits are counted in the API process's memory: they reset when it restarts (or wakes up on
  Render's free tier), and with more than one instance each counts on its own. A shared store
  (Redis) would be needed to scale out.
- Behind a proxy, `TRUST_PROXY` must match the number of proxies (Render: `1`). Too low and every
  signed-out request appears to come from the proxy (one shared per-IP allowance); too high and
  clients can pick their own IP with `X-Forwarded-For`.
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
- Video needs more bandwidth than voice and goes browser to browser like audio (no TURN relay, no
  quality adaptation beyond what the browser does). Networks that block direct connections block
  video calls too.
- "Camera off" relies on the other side's `media` signal (sent on every join and change, and to
  every new tab of theirs). Like mute, it is self-reported: a participant could only mislead the one
  person in their own call.
- A voice call cannot become a video call, and a caller who chose "Continue with voice" stays on
  voice. The callee of a video call can always turn their camera on later.
- The front camera (`facingMode: user`) is always used; there is no camera switch or device picker.
- On a phone the video panel sits over the bottom of the chat (it can be hidden only by ending the
  call); it has not been checked on real phones yet.
- A group's owner cannot leave until someone else is the owner, and an owner who is the group's
  only member cannot leave at all (there is no "delete group" yet).
- Deleting an owner's account leaves their groups without an owner (the database check allows it
  on purpose, or the account could never be deleted). Nobody can then change roles or make anyone
  owner until an owner-recovery feature exists; admins can still rename the group, add people and
  remove regular members.
- A member removed while the group is open in their browser no longer receives anything from the
  database on it (Phase 10). Their open page shows "Conversation not found" after the refetch. If
  that refetch fails (offline at that moment), the page keeps showing what it had until they reload;
  it receives nothing new either way.
- Role changes made by others reach whoever has the group open; other members' conversation lists
  keep the old roles until they reload or the list refreshes (roles are not shown in the list).
- Groups have no picture of their own yet: the two-faces picture comes from the members.
