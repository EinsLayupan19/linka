# Database

PostgreSQL hosted by Supabase, accessed from the API through Drizzle ORM.
Schema: `backend/src/db/schema/`. Migrations: `backend/src/db/migrations/`.

```text
auth.users (Supabase)
   │ 1:1
profiles ──────────────┐
   │                   │ created_by / direct pair / sender / initiator (SET NULL)
   │ members (CASCADE) │
conversation_members ──┤
   │                   │
conversations ─────────┘
   ├── messages ── message_attachments
   └── calls ───── call_participants
```

## Migrations

| Migration                 | Kind      | Contents                                                             |
| ------------------------- | --------- | -------------------------------------------------------------------- |
| `0000_profiles`           | generated | `profiles`, its constraints and select-own policy                   |
| `0001_rls_helpers`        | custom    | `private` schema and `private.is_conversation_member()`             |
| `0002_conversations`      | generated | Enums, the six conversation tables, indexes, RLS and policies, username prefix index |
| `0003_message_cursor_and_retries` | generated | `messages.created_at` to millisecond precision; `messages.client_id` and its unique index |
| `0004_message_broadcast`  | custom    | `message.created` broadcast trigger; `private.can_access_conversation_topic()`; RLS policy on `realtime.messages` |
| `0005_presence_and_markers` | generated | `profiles.last_seen_at`; read/delivery markers to millisecond precision |
| `0006_live_state_events`  | custom    | Triggers for list, receipt and membership events; user and live channel helpers and policies |
| `0007_attachment_uploads` | generated | `attachment_status` enum, `message_type` value `attachment`; upload columns, constraints and indexes on `message_attachments`; `messages_content_length`; pending uploads visible only to their uploader (policy) |
| `0008_attachment_storage` | custom    | `private.attachments_json()`; attachments in message payloads; message triggers deferred to commit; the two private Storage buckets |
| `0009_call_lifecycle`     | generated | `calls.last_heartbeat_at`; `calls_ongoing_idx` for the stale-call sweep |
| `0010_call_signaling`     | custom    | `private.call_json()`; `call.updated` trigger (deferred) to each participant's user channel; `private.can_access_call_topic()` and the `call:<id>` signaling policies |

None are applied to a hosted database yet (no Supabase project).

## Enums

Built from the same value lists as the shared Zod enums (`@linka/shared`), so the API and the
database cannot disagree. Adding a value is an `ALTER TYPE ... ADD VALUE` migration.

| Type                | Values                                          |
| ------------------- | ----------------------------------------------- |
| `conversation_type` | `direct`, `group`                               |
| `member_role`       | `owner`, `admin`, `member`                      |
| `message_type`      | `text`, `attachment`                            |
| `attachment_status` | `pending`, `ready`                              |
| `call_type`         | `voice`, `video`                                |
| `call_status`       | `ringing`, `active`, `ended`, `missed`, `declined` |

## Tables

### `profiles` (Phase 2)

| Column         | Type          | Notes                                                        |
| -------------- | ------------- | ------------------------------------------------------------ |
| `id`           | `uuid` PK     | References `auth.users(id)`, `on delete cascade`             |
| `username`     | `text`        | Unique, lowercase, `^[a-z0-9_]{3,20}$` (CHECK)               |
| `display_name` | `text`        | 1-50 characters, not blank (CHECK)                           |
| `avatar_path`  | `text` null   | Path in the private `avatars` bucket; the API returns a signed `avatarUrl`, never the path |
| `last_seen_at` | `timestamptz(3)` null | "Last seen": reported on start, every 5 min while visible, and on hide; at most one write per minute |
| `created_at`, `updated_at` | `timestamptz` |                                                  |

No email column: email stays in Supabase `auth.users`.

### `conversations`

| Column                | Type                | Notes                                             |
| --------------------- | ------------------- | ------------------------------------------------- |
| `id`                  | `uuid` PK           | `gen_random_uuid()`                               |
| `type`                | `conversation_type` |                                                   |
| `name`                | `text` null         | Groups: required, 1-100 chars. 1:1: always null   |
| `created_by`          | `uuid` null         | → `profiles`, `set null`                          |
| `direct_low_user_id`  | `uuid` null         | 1:1 only, → `profiles`, `set null`                |
| `direct_high_user_id` | `uuid` null         | 1:1 only, → `profiles`, `set null`                |
| `created_at`, `updated_at` | `timestamptz`  |                                                   |

**1:1 uniqueness.** A 1:1 conversation stores its two users ordered (`low < high`, CHECK
`conversations_direct_pair_order`) and the pair is unique (`conversations_direct_pair_unique`).
Because the order is fixed, (A, B) and (B, A) are the same row, so the database rejects a second
1:1 conversation between the same people even if two requests race. Groups must leave the pair
empty (`conversations_direct_shape`). If one of the two accounts is deleted, its column becomes null
and the pair no longer blocks anything.

### `conversation_members`

| Column              | Type            | Notes                                              |
| ------------------- | --------------- | -------------------------------------------------- |
| `conversation_id`   | `uuid`          | → `conversations`, `cascade`                       |
| `user_id`           | `uuid`          | → `profiles`, `cascade`                            |
| `role`              | `member_role`   | Default `member`                                   |
| `joined_at`         | `timestamptz`   |                                                    |
| `last_delivered_at` | `timestamptz(3)` null | Newest message time this member's client received; only moves forward |
| `last_read_at`      | `timestamptz(3)` null | Newest message time this member has read; only moves forward |

- Primary key `(conversation_id, user_id)`: no duplicate membership.
- `conversation_members_one_owner_idx`: partial unique index, at most one `owner` per conversation.
- Leaving deletes the row (no membership history yet).

### `messages`

| Column            | Type           | Notes                                                    |
| ----------------- | -------------- | -------------------------------------------------------- |
| `id`              | `uuid` PK      |                                                          |
| `conversation_id` | `uuid`         | → `conversations`, `cascade`                             |
| `sender_id`       | `uuid` null    | → `profiles`, `set null` (history survives account deletion) |
| `type`            | `message_type` | Default `text`                                           |
| `content`         | `text` null    | `text` messages: not null, not blank, at most 4000 chars; `attachment` messages: optional caption, at most 4000 (`messages_content_length`); stored as typed |
| `created_at`      | `timestamptz(3)` | Millisecond precision, matching API timestamps and cursors exactly |
| `client_id`       | `uuid` null    | Sender's idempotency key; unique per sender              |
| `edited_at`       | `timestamptz` null | Per PLAN.md (editing UI comes later)                  |
| `deleted_at`      | `timestamptz` null | Soft delete: keeps cursors and history consistent     |

**Ordering and pagination.** Messages are ordered by `(created_at, id)`; the id breaks ties
between messages created in the same millisecond. Pages are read with a row-value comparison
`(created_at, id) < (cursor)` on the `(conversation_id, created_at, id)` index; see the cursor
format in [ARCHITECTURE.md](ARCHITECTURE.md#message-pagination). `content` is nullable for
attachment-only messages (Phase 6); `messages_id_conversation_unique (id, conversation_id)` exists
so attachments can reference a message *and* its conversation.

**Retries.** `messages_sender_client_id_idx` is a partial unique index on `(sender_id, client_id)`
(where `client_id` is set). Sending again with the same `client_id` finds the original row instead
of inserting a duplicate, including when two attempts race.

**Activity.** Storing a message sets `conversations.updated_at` to the message's `created_at` (in the
same transaction), so conversation lists sort by last activity without another column.

**Realtime trigger.** `messages_broadcast_created` (`AFTER INSERT`, per row; since Phase 6 a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger, so it runs at commit and the payload includes
the attachments linked in the same transaction) calls
`private.broadcast_message_created()`, which sends event `message.created` on the private topic
`conversation:<conversation_id>` via `realtime.send()`. The payload has exactly the shape of the
shared `Message` contract (camelCase, `createdAt` formatted like JavaScript's `toISOString()`).
Errors from `realtime.send()` are caught and logged as warnings: the message is stored regardless.
Retries that find an existing row do not insert, so they do not broadcast again.

### `message_attachments` (reshaped in Phase 6)

One row per uploaded file, created when an upload **starts** (before any message exists) and linked
to a message when it is sent.

| Column            | Type                | Notes                                                             |
| ----------------- | ------------------- | ----------------------------------------------------------------- |
| `id`              | `uuid` PK           | Also the file's name in Storage                                   |
| `conversation_id` | `uuid`              | → `conversations`, `cascade`                                      |
| `message_id`      | `uuid` null         | null until sent; → `messages` via `(message_id, conversation_id)`, `cascade` |
| `uploader_id`     | `uuid` null         | → `profiles`, `set null`                                          |
| `client_id`       | `uuid`              | Uploader's idempotency key; unique per uploader                   |
| `status`          | `attachment_status` | `pending` until the API verified the uploaded bytes, then `ready` |
| `storage_path`    | `text`              | Unique; chosen by the server; never returned by the API           |
| `file_name`       | `text`              | Display name only, 1-255 characters                               |
| `content_type`    | `text`              | One of the allowed types (CHECK)                                  |
| `size_bytes`      | `bigint`            | `> 0` and at most 25 MB (CHECK)                                   |
| `created_at`      | `timestamptz`       | Age for the unsent-upload sweep                                   |

Constraints that make bad states impossible, whatever the API does:

- `message_attachments_message_fk`: the composite foreign key `(message_id, conversation_id)` →
  `messages(id, conversation_id)` (backed by `messages_id_conversation_unique`), so an attachment
  can never be linked to a message in another conversation.
- `message_attachments_attached_ready`: only a `ready` upload can be linked to a message.
- `message_attachments_path_shape`: the path is exactly
  `<conversation_id>/<uploader uuid>/<id>.<ext>` (ext `[a-z0-9]{1,5}`), the middle part equals
  `uploader_id` while the uploader exists, and nothing else (no `..`, no extra segments).
- `message_attachments_uploader_client_idx`: one upload per `(uploader_id, client_id)`, so a
  retried start never creates a second row.
- `message_attachments_content_type`, `_size_positive`, `_size_limit`, `_file_name_length`.

**Sending.** The API locks the listed rows (`SELECT ... FOR UPDATE`): they must belong to the
caller, be in this conversation, be `ready` and be unsent, or the send fails with 400 and nothing
is stored. Two sends racing for the same upload cannot both link it.

**Unsent uploads** (`message_id is null`) are found through the partial index
`message_attachments_unattached_idx (created_at) where message_id is null`; the API's sweep deletes
those older than 24 hours (row first, then file).

### `calls`

| Column            | Type          | Notes                               |
| ----------------- | ------------- | ----------------------------------- |
| `id`              | `uuid` PK     |                                     |
| `conversation_id` | `uuid`        | → `conversations`, `cascade`        |
| `initiator_id`    | `uuid` null   | → `profiles`, `set null`            |
| `type`            | `call_type`   |                                     |
| `status`          | `call_status` | Default `ringing`                   |
| `started_at`      | `timestamptz` null | When answered                  |
| `ended_at`        | `timestamptz` null | `>= started_at`                |
| `created_at`      | `timestamptz` |                                     |
| `last_heartbeat_at` | `timestamptz` | Phase 7: last "still here" from a connected participant (default now) |

`calls_one_ongoing_per_conversation_idx`: partial unique index, at most one `ringing` or `active`
call per conversation.

**Lifecycle (Phase 7).** Only the API writes these rows, with conditional updates
(`WHERE status = 'ringing'`) so racing requests resolve to one outcome. Calls are 1:1 (two
participants: the caller joined at start, the callee when answering). `ringing` older than 60 s
becomes `missed`, and `active` without a heartbeat for 60 s becomes `ended`; this runs before
starting, answering or listing calls and in a 30 s sweep, using `calls_ongoing_idx` (partial, on
ringing and active calls). Ending a call sets `left_at` for everyone who joined. All timestamps
come from the database clock, so `calls_end_after_start` and `call_participants_leave_after_join`
hold even when the API's clock drifts.

### `call_participants`

Primary key `(call_id, user_id)`. `call_id` → `calls` (`cascade`), `user_id` → `profiles`
(`cascade`). `joined_at` is null while the call rings for that person; `left_at` requires
`joined_at` and must not be earlier.

## Read, delivery and unread state (Phase 5)

- **Markers, not receipt rows.** A message is delivered to / read by a member when its `created_at`
  is at or before that member's `last_delivered_at` / `last_read_at`. There is no delivery or
  receipt table. The client coalesces marker updates, and the database only writes when a marker
  actually moves forward.
- **Never backwards, never ahead.** Updates are conditioned on `last_x IS NULL OR last_x < new`, so
  a stale value changes nothing (read answers 409, delivery skips it). A marker can never be set
  past the conversation's newest message. Reading also raises `last_delivered_at` (`greatest`).
- **Delivery batches** update up to 50 conversations in one statement (`CASE conversation_id`).
- **Unread count** per conversation is computed inside the list query: a correlated
  `count(*)` over `SELECT 1 FROM messages m WHERE m.conversation_id = cm.conversation_id AND
  m.created_at > coalesce(cm.last_read_at, '-infinity') AND m.sender_id IS DISTINCT FROM
  cm.user_id LIMIT 100`. It is an index range scan on `(conversation_id, created_at, id)` that stops
  at 100. No counter table, so counts survive refreshes and cannot drift.
- **Millisecond markers:** markers hold message `created_at` values (milliseconds since Phase 4),
  so they compare exactly.

## Realtime triggers (Phase 5)

All publish with `realtime.send(payload, event, topic, private => true)` and catch their own errors
(logged as `linka: broadcasting ... failed`), so a realtime failure never blocks the write. Payloads
are built by `private.message_json()` and `private.iso()` to match the shared contracts exactly.

| Trigger | When | Publishes |
| ------- | ---- | --------- |
| `messages_broadcast_created` (Phase 4) | after insert on `messages` | `message.created` on `conversation:<id>` |
| `messages_broadcast_activity` | after insert on `messages` (deferred to commit since Phase 6) | `conversation.activity` on each member's `user:<id>` (at most 100) |
| `conversation_members_broadcast_markers` | a member's markers actually changed | `receipt.updated` on `conversation:<id>`; `conversation.read` on that member's `user:<id>` |
| `conversation_members_broadcast_added` / `_removed` | per statement (transition tables) | `conversation.changed` to each affected user; one `conversation.updated` per conversation |
| `conversation_members_broadcast_role` | a role changed | `conversation.updated` |
| `conversations_broadcast_renamed` | the name changed (not activity bumps) | `conversation.updated`; `conversation.changed` (updated) to each member |
| `calls_broadcast_updated` (Phase 7) | insert, or a status change, on `calls` (deferred to commit; heartbeats do not publish) | `call.updated` (the full `Call`, participants included) on each participant's `user:<id>` |

**Write cost.** `realtime.send()` stores each event in Supabase's `realtime.messages` log, which
Supabase prunes after about 3 days. A new message therefore writes one row for the conversation
channel plus one per member for the live list, bounded by the 100-member group limit. Application
tables get no per-recipient writes. If this fan-out ever matters, it can move to a background worker
without changing the client contract.

**Lesson recorded in the triggers:** values computed in a plpgsql `DECLARE` run outside the
function's `EXCEPTION` block. Every payload is therefore built inside the protected block, so even a
broken payload cannot block a write.

## Indexes and why

| Index                                   | Serves                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| `conversation_members` PK `(conversation_id, user_id)` | Members of a conversation; membership check |
| `conversation_members_user_id_idx`      | "My conversations" (the PK starts with `conversation_id`) |
| `conversations_direct_pair_unique`      | Finding the existing 1:1 conversation of two users        |
| `messages_conversation_created_idx` `(conversation_id, created_at, id)` | History and cursor pagination in both directions; also plain `conversation_id` lookups, so no separate index |
| `messages_sender_id_idx`                | `ON DELETE SET NULL` when a user is deleted; "messages by user" |
| `messages_sender_client_id_idx` (partial unique) | Finding a retried send by `(sender_id, client_id)`; prevents duplicates |
| `message_attachments_message_id_idx`    | Attachments of a page of messages (one query per page)    |
| `message_attachments_uploader_client_idx` | Finding a retried upload start; prevents duplicates  |
| `message_attachments_unattached_idx` (partial) | The unsent-upload sweep                             |
| `calls_conversation_created_idx`        | Call history of a conversation                            |
| `calls_ongoing_idx` (partial)           | Ringing and active calls: the stale-call sweep, busy checks |
| `call_participants_user_id_idx`         | A user's calls; `ON DELETE CASCADE` from profiles         |
| `profiles_username_prefix_idx` (`text_pattern_ops`) | Username search (`LIKE 'abc%'`); the unique index cannot serve `LIKE` under a non-C collation |

Deliberately not indexed: `conversations.created_by`, `direct_high_user_id` and
`calls.initiator_id`. Nothing queries by them; the only cost is a slower `SET NULL` during the rare
account deletion.

## Row Level Security

RLS is enabled on **every** table in `public` (a test fails if a new table forgets it). Every table
has exactly one policy, for `SELECT`, for the `authenticated` role:

| Table                  | A signed-in user can read rows of...                                   |
| ---------------------- | ---------------------------------------------------------------------- |
| `profiles`             | their own profile                                                      |
| `conversations`        | conversations they are a member of                                     |
| `conversation_members` | memberships of conversations they belong to (who else is in them)      |
| `messages`             | messages in their conversations                                        |
| `message_attachments`  | attachments of messages in their conversations, plus their own unsent uploads (never other people's) |
| `calls`                | calls in their conversations                                           |
| `call_participants`    | participants of calls in their conversations                           |

There are **no insert, update or delete policies**: browser clients with the publishable key cannot
write any of these tables. All writes go through the API, which validates input and checks roles.
`anon` has no policies at all.

**Realtime channels (`realtime.messages`, Supabase's table).** Policy
`linka_conversation_members_receive_broadcasts`: `authenticated` users may `SELECT` Broadcast
messages only when `private.can_access_conversation_topic((select realtime.topic()))` is true, i.e.
the topic is exactly `conversation:<uuid>` and they are a member. Supabase uses this to authorize
joining a private channel. No INSERT policy: browser clients cannot publish on these topics.

**User and live channels (Phase 5).**

- `linka_users_receive_own_events`: `SELECT` broadcast only on exactly `user:<auth.uid()>`
  (`private.can_access_user_topic`). No INSERT: only the database publishes there.
- `linka_conversation_members_receive_live` and `linka_conversation_members_publish_live`: `SELECT`
  and `INSERT` for broadcast and presence on `live:<uuid>`, for members
  (`private.can_access_live_topic`).

**Call channels (Phase 7).** `linka_call_participants_receive_signals` and
`linka_call_participants_publish_signals`: `SELECT` and `INSERT` of broadcasts on exactly
`call:<uuid>` when the user is a participant of that call, still a member of its conversation,
and the call is `ringing` or `active` (`private.can_access_call_topic`, `SECURITY DEFINER`, empty
`search_path`). Presence is not allowed there. `live:<id>` and `call:<id>` are the only topics
browser clients may publish on; the audio itself is never stored or relayed by Linka.

**Storage (Phase 6).** Buckets `attachments` and `avatars` are private and have **no**
`storage.objects` policies for `anon` or `authenticated`: browsers cannot list, read or write them
directly. Only the API (secret key) uploads, inspects, signs and deletes; browsers use signed URLs
scoped to one object. Do not add Storage policies or make a bucket public.

**The membership helper.** Policies call `private.is_conversation_member(conversation_id)`
(migration `0001_rls_helpers`). A policy on `conversation_members` that queried
`conversation_members` itself would recurse, so the lookup runs in a `SECURITY DEFINER` function
with an empty `search_path` (Supabase's recommended pattern). It lives in the `private` schema, which
Supabase's API does not expose, and only `authenticated` may execute it. It always answers for the
current user (`auth.uid()`), never for an arbitrary user.

## Security model

- The API connects with a privileged database role, which **bypasses RLS**. Authorization for API
  routes is therefore enforced in the backend services (`requireMembership`, role rules in
  `conversationPermissions.ts`), always using the user ID from the verified access token.
- The browser holds the public Supabase key and can reach tables through Supabase's Data API and
  Realtime. RLS is what protects that path.

## Migrations: Drizzle owns everything

All schema changes, including RLS policies and other custom SQL, go through Drizzle migrations.
Never change the schema by hand in the Supabase dashboard, or migrations and the real database will
drift apart.

`drizzle.config.ts` limits Drizzle to the `public` schema and treats Supabase's roles as existing,
so migrations never try to create `auth` objects. Objects outside `public` (like the `private`
helper) are created in custom migrations.

```bash
cd backend

# 1. Table and policy changes: edit src/db/schema/*.ts, then
npm run db:generate

# 2. Other custom SQL (functions, triggers): create an empty migration and write the SQL
npx drizzle-kit generate --custom --name=<short_name>

# 3. Apply pending migrations to the database in DATABASE_URL
npm run db:migrate
```

Review every generated SQL file before applying it and commit it with the schema change.

**Lesson recorded in the schema:** a CHECK constraint that evaluates to `NULL` passes. Conditions on
nullable columns therefore say `is not null` explicitly (for example `conversations_name_shape` and
`messages_text_content`).

## Testing

Database tests run the real migrations against **PGlite**, an in-memory Postgres (test-only, not a
development database). `backend/src/test/db.ts` recreates the parts of Supabase the migrations use:
the `anon` and `authenticated` roles with Supabase's default table grants, `auth.users`,
`auth.uid()` reading the request's JWT claims, and a reduced `realtime` schema (`realtime.messages`
with RLS, `realtime.send()`, `realtime.topic()`). Channel joins are simulated the way Supabase
authorizes them: insert a probe message for the topic, try to read it as the user, roll back. Tests switch to those roles to check RLS the way the
Data API applies it, and a control test disables RLS inside a rolled-back transaction to prove the
policies are what block outsiders.
