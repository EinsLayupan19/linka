import { randomUUID } from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// Real migrations on an in-memory Postgres (PGlite). These tests check what the database
// itself enforces for browser clients (RLS) and for everyone (constraints).

let t: TestDatabase;
let maya: string; // owner of the group
let jonas: string; // member of the group
let outsider: string; // member of a different conversation only
let groupId: string;
let otherId: string;
let messageId: string;
let callId: string;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await t.client.query<T>(sql, params);
  return rows[0] as T;
}

const asUser = <T>(userId: string, run: (tx: Transaction) => Promise<T>) => t.asRole('authenticated', userId, run);
const rowsAs = (userId: string, sql: string, params: unknown[] = []) =>
  asUser(userId, async (tx) => (await tx.query(sql, params)).rows);

let seedAttachmentPath: string;

/** An attachment row in the Phase 6 shape (path <conversation>/<uploader>/<id>.<ext>). */
async function insertAttachment(o: {
  conversationId: string;
  messageId: string | null;
  uploaderId: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  storagePath?: string;
}) {
  const id = randomUUID();
  const fileName = o.fileName ?? 'plan.pdf';
  const storagePath = o.storagePath ?? `${o.conversationId}/${o.uploaderId}/${id}.${fileName.split('.').pop()}`;
  await t.client.query(
    `insert into message_attachments (id, conversation_id, message_id, uploader_id, client_id, status, storage_path, file_name, content_type, size_bytes)
     values ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, $9)`,
    [id, o.conversationId, o.messageId, o.uploaderId, randomUUID(), storagePath, fileName, o.contentType ?? 'application/pdf', o.sizeBytes ?? 2048],
  );
  return { id, storagePath };
}

beforeAll(async () => {
  t = await createTestDatabase();
  maya = await t.createUser('maya');
  jonas = await t.createUser('jonas');
  outsider = await t.createUser('outsider');

  ({ id: groupId } = await one<{ id: string }>(
    "insert into conversations (type, name, created_by) values ('group', 'Weekend trip', $1) returning id",
    [maya],
  ));
  await t.client.query(
    "insert into conversation_members (conversation_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member')",
    [groupId, maya, jonas],
  );

  ({ id: otherId } = await one<{ id: string }>(
    "insert into conversations (type, name, created_by) values ('group', 'Elsewhere', $1) returning id",
    [outsider],
  ));
  await t.client.query("insert into conversation_members (conversation_id, user_id, role) values ($1, $2, 'owner')", [
    otherId,
    outsider,
  ]);

  ({ id: messageId } = await one<{ id: string }>(
    "insert into messages (conversation_id, sender_id, content) values ($1, $2, 'See you Saturday') returning id",
    [groupId, maya],
  ));
  ({ storagePath: seedAttachmentPath } = await insertAttachment({ conversationId: groupId, messageId, uploaderId: maya }));
  ({ id: callId } = await one<{ id: string }>(
    "insert into calls (conversation_id, initiator_id, type) values ($1, $2, 'voice') returning id",
    [groupId, maya],
  ));
  await t.client.query('insert into call_participants (call_id, user_id, joined_at) values ($1, $2, now()), ($1, $3, null)', [
    callId,
    maya,
    jonas,
  ]);
});

afterAll(async () => {
  await t.close();
});

describe('RLS is on everywhere', () => {
  it('enables row level security on every table in the public schema', async () => {
    const { rows } = await t.client.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'call_participants',
      'calls',
      'conversation_members',
      'conversations',
      'message_attachments',
      'messages',
      'profiles',
    ]);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it('only defines SELECT policies (writes go through the API)', async () => {
    const { rows } = await t.client.query<{ cmd: string }>(
      "select distinct cmd from pg_policies where schemaname = 'public'",
    );
    expect(rows).toEqual([{ cmd: 'SELECT' }]);
  });
});

describe('members see their conversations, and only theirs', () => {
  it('conversations', async () => {
    expect(await rowsAs(maya, 'select name from conversations')).toEqual([{ name: 'Weekend trip' }]);
    expect(await rowsAs(outsider, 'select name from conversations')).toEqual([{ name: 'Elsewhere' }]);
  });

  it('conversation members (co-members visible, other conversations not)', async () => {
    const seenByJonas = await rowsAs(jonas, 'select user_id from conversation_members order by role');
    expect(seenByJonas).toEqual([{ user_id: maya }, { user_id: jonas }]);
    expect(await rowsAs(outsider, 'select user_id from conversation_members')).toEqual([{ user_id: outsider }]);
  });

  it('messages', async () => {
    expect(await rowsAs(jonas, 'select content from messages')).toEqual([{ content: 'See you Saturday' }]);
    expect(await rowsAs(outsider, 'select * from messages')).toEqual([]);
  });

  it('message attachments', async () => {
    expect(await rowsAs(jonas, 'select file_name from message_attachments')).toEqual([{ file_name: 'plan.pdf' }]);
    expect(await rowsAs(outsider, 'select * from message_attachments')).toEqual([]);
  });

  it('calls and call participants', async () => {
    expect(await rowsAs(jonas, 'select type from calls')).toEqual([{ type: 'voice' }]);
    expect(await rowsAs(jonas, 'select user_id from call_participants')).toHaveLength(2);
    expect(await rowsAs(outsider, 'select * from calls')).toEqual([]);
    expect(await rowsAs(outsider, 'select * from call_participants')).toEqual([]);
  });

  it('even a direct lookup by id returns nothing for outsiders', async () => {
    expect(await rowsAs(outsider, 'select * from conversations where id = $1', [groupId])).toEqual([]);
    expect(await rowsAs(outsider, 'select * from messages where id = $1', [messageId])).toEqual([]);
  });

  it('anonymous requests see nothing at all', async () => {
    for (const table of ['conversations', 'conversation_members', 'messages', 'message_attachments', 'calls', 'call_participants']) {
      const rows = await t.asRole('anon', null, async (tx) => (await tx.query(`select * from ${table}`)).rows);
      expect(rows, table).toEqual([]);
    }
  });
});

describe('browser clients cannot write', () => {
  it('cannot send a message directly, even as a member', async () => {
    await expect(
      asUser(jonas, (tx) =>
        tx.query("insert into messages (conversation_id, sender_id, content) values ($1, $2, 'direct')", [groupId, jonas]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot add themselves to someone else’s conversation', async () => {
    await expect(
      asUser(outsider, (tx) =>
        tx.query("insert into conversation_members (conversation_id, user_id) values ($1, $2)", [groupId, outsider]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot promote themselves, rename the group or delete messages', async () => {
    const affected = await asUser(jonas, async (tx) => [
      (await tx.query("update conversation_members set role = 'owner' where user_id = $1", [jonas])).affectedRows,
      (await tx.query("update conversations set name = 'Hijacked'")).affectedRows,
      (await tx.query('delete from messages')).affectedRows,
    ]);
    expect(affected).toEqual([0, 0, 0]);
    expect(await one<{ role: string }>('select role from conversation_members where user_id = $1', [jonas])).toEqual({
      role: 'member',
    });
  });

  it('cannot start calls directly', async () => {
    await expect(
      asUser(jonas, (tx) =>
        tx.query("insert into calls (conversation_id, initiator_id, type) values ($1, $2, 'video')", [otherId, jonas]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('the membership helper', () => {
  it('cannot be called by anonymous clients', async () => {
    await expect(
      t.asRole('anon', null, (tx) => tx.query('select private.is_conversation_member($1)', [groupId])),
    ).rejects.toThrow(/permission denied/);
  });

  it('answers only for the current user', async () => {
    const result = await asUser(outsider, async (tx) =>
      (await tx.query<{ member: boolean }>('select private.is_conversation_member($1) as member', [groupId])).rows[0],
    );
    expect(result).toEqual({ member: false });
  });
});

describe('RLS is what blocks outsiders', () => {
  it('with RLS disabled the same outsider query leaks the message (control)', async () => {
    const leaked = await t.client.transaction(async (tx) => {
      await tx.exec('alter table messages disable row level security');
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: outsider })]);
      const { rows } = await tx.query('select content from messages');
      await tx.rollback();
      return rows;
    });
    expect(leaked).toEqual([{ content: 'See you Saturday' }]);

    // Rolled back: RLS is on again and the outsider sees nothing.
    expect(await rowsAs(outsider, 'select * from messages')).toEqual([]);
  });
});

describe('conversation constraints', () => {
  const insertDirect = (low: string | null, high: string | null, name: string | null = null) =>
    t.client.query(
      "insert into conversations (type, name, direct_low_user_id, direct_high_user_id) values ('direct', $1, $2, $3)",
      [name, low, high],
    );
  const ordered = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

  it('allows only one 1:1 conversation per pair of users', async () => {
    const [low, high] = ordered(await t.createUser(), await t.createUser());
    await insertDirect(low, high);
    await expect(insertDirect(low, high)).rejects.toThrow(/conversations_direct_pair_unique/);
  });

  it('stores pairs low-first, so the reversed pair cannot sneak in', async () => {
    const [low, high] = ordered(await t.createUser(), await t.createUser());
    await expect(insertDirect(high, low)).rejects.toThrow(/conversations_direct_pair_order/);
  });

  it('requires a name for groups and none for 1:1 conversations', async () => {
    await expect(t.client.query("insert into conversations (type) values ('group')")).rejects.toThrow(
      /conversations_name_shape/,
    );
    await expect(t.client.query("insert into conversations (type, name) values ('group', '   ')")).rejects.toThrow(
      /conversations_name_shape/,
    );
    const [low, high] = ordered(await t.createUser(), await t.createUser());
    await expect(insertDirect(low, high, 'Named')).rejects.toThrow(/conversations_name_shape/);
  });

  it('keeps the 1:1 pair columns empty on groups', async () => {
    const [low, high] = ordered(await t.createUser(), await t.createUser());
    await expect(
      t.client.query(
        "insert into conversations (type, name, direct_low_user_id, direct_high_user_id) values ('group', 'G', $1, $2)",
        [low, high],
      ),
    ).rejects.toThrow(/conversations_direct_shape/);
  });

  it('rejects unknown conversation types', async () => {
    await expect(t.client.query("insert into conversations (type, name) values ('channel', 'x')")).rejects.toThrow(
      /invalid input value for enum conversation_type/,
    );
  });
});

describe('membership constraints', () => {
  it('prevents duplicate membership', async () => {
    await expect(
      t.client.query('insert into conversation_members (conversation_id, user_id) values ($1, $2)', [groupId, jonas]),
    ).rejects.toThrow(/conversation_members_pkey/);
  });

  it('allows at most one owner per conversation', async () => {
    const newcomer = await t.createUser();
    await expect(
      t.client.query("insert into conversation_members (conversation_id, user_id, role) values ($1, $2, 'owner')", [
        groupId,
        newcomer,
      ]),
    ).rejects.toThrow(/conversation_members_one_owner_idx/);
  });

  it('rejects unknown roles and non-existent users', async () => {
    const newcomer = await t.createUser();
    await expect(
      t.client.query("insert into conversation_members (conversation_id, user_id, role) values ($1, $2, 'superuser')", [
        groupId,
        newcomer,
      ]),
    ).rejects.toThrow(/invalid input value for enum member_role/);
    await expect(
      t.client.query('insert into conversation_members (conversation_id, user_id) values ($1, $2)', [
        groupId,
        '8b1e3f0a-2c4d-4e6f-9a1b-3c5d7e9f1a2b',
      ]),
    ).rejects.toThrow(/conversation_members_user_id_profiles_id_fk/);
  });
});

describe('message and attachment constraints', () => {
  it.each([
    ['null content', null],
    ['blank content', '   '],
    ['content over 4000 characters', 'x'.repeat(4001)],
  ])('rejects a text message with %s', async (_label, content) => {
    await expect(
      t.client.query('insert into messages (conversation_id, sender_id, content) values ($1, $2, $3)', [groupId, maya, content]),
      // Phase 6 added messages_content_length (captions); for over-long text either check may fire.
    ).rejects.toThrow(/messages_(text_content|content_length)/);
  });

  it('requires the message to belong to an existing conversation', async () => {
    await expect(
      t.client.query("insert into messages (conversation_id, sender_id, content) values ($1, $2, 'hi')", [
        '2c4d6e8f-0a1b-4c3d-8e5f-7a9b1c3d5e7f',
        maya,
      ]),
    ).rejects.toThrow(/messages_conversation_id_conversations_id_fk/);
  });

  it('requires attachments to belong to an existing message', async () => {
    // Phase 6: the key is (message_id, conversation_id), so it is named message_attachments_message_fk.
    await expect(
      insertAttachment({ conversationId: groupId, messageId: '3d5e7f9a-1b2c-4d3e-9f6a-8b0c2d4e6f8a', uploaderId: maya }),
    ).rejects.toThrow(/message_attachments_message_fk/);
  });

  it('rejects empty files and reusing another row’s storage path', async () => {
    const base = { conversationId: groupId, messageId, uploaderId: maya, fileName: 'a.png', contentType: 'image/png' };
    await expect(insertAttachment({ ...base, sizeBytes: 0 })).rejects.toThrow(/message_attachments_size_positive/);
    // Phase 6: a path must contain the row's own id, so another row's path is rejected by the
    // path-shape check before uniqueness is even reached.
    await expect(insertAttachment({ ...base, storagePath: seedAttachmentPath })).rejects.toThrow(/message_attachments_path_shape/);
  });
});

describe('call constraints', () => {
  it('rejects unknown call types', async () => {
    await expect(
      t.client.query("insert into calls (conversation_id, initiator_id, type) values ($1, $2, 'hologram')", [otherId, outsider]),
    ).rejects.toThrow(/invalid input value for enum call_type/);
  });

  it('allows only one ringing or active call per conversation, but any number of finished ones', async () => {
    await expect(
      t.client.query("insert into calls (conversation_id, initiator_id, type) values ($1, $2, 'video')", [groupId, jonas]),
    ).rejects.toThrow(/calls_one_ongoing_per_conversation_idx/);

    await t.client.query(
      "insert into calls (conversation_id, initiator_id, type, status, started_at, ended_at) values ($1, $2, 'voice', 'ended', now() - interval '5 minutes', now())",
      [groupId, jonas],
    );
  });

  it('rejects a call that ends before it starts, and leaving before joining', async () => {
    await expect(
      t.client.query(
        "insert into calls (conversation_id, type, status, started_at, ended_at) values ($1, 'voice', 'ended', now(), now() - interval '1 minute')",
        [otherId],
      ),
    ).rejects.toThrow(/calls_end_after_start/);
    await expect(
      t.client.query('insert into call_participants (call_id, user_id, joined_at, left_at) values ($1, $2, null, now())', [
        callId,
        outsider,
      ]),
    ).rejects.toThrow(/call_participants_leave_after_join/);
  });
});

describe('deletes', () => {
  it('deleting a conversation removes its members, messages, attachments and calls', async () => {
    const owner = await t.createUser();
    const { id } = await one<{ id: string }>("insert into conversations (type, name) values ('group', 'Temp') returning id");
    await t.client.query("insert into conversation_members (conversation_id, user_id, role) values ($1, $2, 'owner')", [id, owner]);
    const { id: msg } = await one<{ id: string }>(
      "insert into messages (conversation_id, sender_id, content) values ($1, $2, 'bye') returning id",
      [id, owner],
    );
    await insertAttachment({ conversationId: id, messageId: msg, uploaderId: owner, fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 1 });
    await t.client.query("insert into calls (conversation_id, type) values ($1, 'voice')", [id]);

    await t.client.query('delete from conversations where id = $1', [id]);

    const counts = await one<Record<string, number>>(
      `select
        (select count(*)::int from conversation_members where conversation_id = $1) as members,
        (select count(*)::int from messages where conversation_id = $1) as messages,
        (select count(*)::int from message_attachments where message_id = $2) as attachments,
        (select count(*)::int from calls where conversation_id = $1) as calls`,
      [id, msg],
    );
    expect(counts).toEqual({ members: 0, messages: 0, attachments: 0, calls: 0 });
  });

  it('deleting a user keeps their messages for others, without the sender', async () => {
    const leaver = await t.createUser();
    await t.client.query('insert into conversation_members (conversation_id, user_id) values ($1, $2)', [groupId, leaver]);
    const { id } = await one<{ id: string }>(
      "insert into messages (conversation_id, sender_id, content) values ($1, $2, 'Goodbye') returning id",
      [groupId, leaver],
    );

    await t.client.query('delete from auth.users where id = $1', [leaver]);

    expect(await one('select sender_id, content from messages where id = $1', [id])).toEqual({
      sender_id: null,
      content: 'Goodbye',
    });
    expect(
      await one<{ n: number }>('select count(*)::int as n from conversation_members where user_id = $1', [leaver]),
    ).toEqual({ n: 0 });
  });
});
