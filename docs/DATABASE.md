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

None are applied to a hosted database yet (no Supabase project).

## Enums

Built from the same value lists as the shared Zod enums (`@linka/shared`), so the API and the
database cannot disagree. Adding a value is an `ALTER TYPE ... ADD VALUE` migration.

| Type                | Values                                          |
| ------------------- | ----------------------------------------------- |
| `conversation_type` | `direct`, `group`                               |
| `member_role`       | `owner`, `admin`, `member`                      |
| `message_type`      | `text`                                          |
| `call_type`         | `voice`, `video`                                |
| `call_status`       | `ringing`, `active`, `ended`, `missed`, `declined` |

## Tables

### `profiles` (Phase 2)

| Column         | Type          | Notes                                                        |
| -------------- | ------------- | ------------------------------------------------------------ |
| `id`           | `uuid` PK     | References `auth.users(id)`, `on delete cascade`             |
| `username`     | `text`        | Unique, lowercase, `^[a-z0-9_]{3,20}$` (CHECK)               |
| `display_name` | `text`        | 1-50 characters, not blank (CHECK)                           |
| `avatar_path`  | `text` null   | Storage path, filled in by the media phase                   |
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
| `last_delivered_at` | `timestamptz` null | Per-member delivery marker (filled in Phase 5)  |
| `last_read_at`      | `timestamptz` null | Per-member read marker (filled in Phase 5)      |

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
| `content`         | `text` null    | `text` messages: not null, not blank, at most 4000 chars; stored as typed |
| `created_at`      | `timestamptz(3)` | Millisecond precision, matching API timestamps and cursors exactly |
| `client_id`       | `uuid` null    | Sender's idempotency key; unique per sender              |
| `edited_at`       | `timestamptz` null | Per PLAN.md (editing UI comes later)                  |
| `deleted_at`      | `timestamptz` null | Soft delete: keeps cursors and history consistent     |

**Ordering and pagination.** Messages are ordered by `(created_at, id)`; the id breaks ties
between messages created in the same millisecond. Pages are read with a row-value comparison
`(created_at, id) < (cursor)` on the `(conversation_id, created_at, id)` index; see the cursor
format in [ARCHITECTURE.md](ARCHITECTURE.md#message-pagination). `content` is nullable so future
types (for example attachment-only messages) do not need a rewrite; the CHECK only constrains
`text` messages.

**Retries.** `messages_sender_client_id_idx` is a partial unique index on `(sender_id, client_id)`
(where `client_id` is set). Sending again with the same `client_id` finds the original row instead
of inserting a duplicate, including when two attempts race.

**Activity.** Storing a message sets `conversations.updated_at` to the message's `created_at` (in the
same transaction), so conversation lists sort by last activity without another column.

**Realtime trigger.** `messages_broadcast_created` (`AFTER INSERT`, per row) calls
`private.broadcast_message_created()`, which sends event `message.created` on the private topic
`conversation:<conversation_id>` via `realtime.send()`. The payload has exactly the shape of the
shared `Message` contract (camelCase, `createdAt` formatted like JavaScript's `toISOString()`).
Errors from `realtime.send()` are caught and logged as warnings: the message is stored regardless.
Retries that find an existing row do not insert, so they do not broadcast again.

### `message_attachments`

| Column         | Type        | Notes                                 |
| -------------- | ----------- | ------------------------------------- |
| `id`           | `uuid` PK   |                                       |
| `message_id`   | `uuid`      | → `messages`, `cascade`               |
| `storage_path` | `text`      | Unique: two rows never share a file   |
| `file_name`    | `text`      | 1-255 characters                      |
| `content_type` | `text`      | Validated properly in the media phase |
| `size_bytes`   | `bigint`    | `> 0`                                 |
| `created_at`   | `timestamptz` |                                     |

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

`calls_one_ongoing_per_conversation_idx`: partial unique index, at most one `ringing` or `active`
call per conversation.

### `call_participants`

Primary key `(call_id, user_id)`. `call_id` → `calls` (`cascade`), `user_id` → `profiles`
(`cascade`). `joined_at` is null while the call rings for that person; `left_at` requires
`joined_at` and must not be earlier.

## Indexes and why

| Index                                   | Serves                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| `conversation_members` PK `(conversation_id, user_id)` | Members of a conversation; membership check |
| `conversation_members_user_id_idx`      | "My conversations" (the PK starts with `conversation_id`) |
| `conversations_direct_pair_unique`      | Finding the existing 1:1 conversation of two users        |
| `messages_conversation_created_idx` `(conversation_id, created_at, id)` | History and cursor pagination in both directions; also plain `conversation_id` lookups, so no separate index |
| `messages_sender_id_idx`                | `ON DELETE SET NULL` when a user is deleted; "messages by user" |
| `messages_sender_client_id_idx` (partial unique) | Finding a retried send by `(sender_id, client_id)`; prevents duplicates |
| `message_attachments_message_id_idx`    | Attachments of a page of messages                         |
| `calls_conversation_created_idx`        | Call history of a conversation                            |
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
| `message_attachments`  | attachments of messages in their conversations                         |
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
