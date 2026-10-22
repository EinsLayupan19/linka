import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTACHMENT_CONTENT_TYPES,
  AVATAR_CONTENT_TYPES,
  CONVERSATION_ACTIVITY_EVENT,
  conversationActivityEventSchema,
  conversationTopic,
  MAX_AVATAR_BYTES,
  MAX_FILE_BYTES,
  MESSAGE_CREATED_EVENT,
  messageSchema,
  userTopic,
} from '@linka/shared';
import { createAttachmentStore } from '../services/attachments.js';
import { createConversationStore } from '../services/conversations.js';
import { createMessageStore } from '../services/messages.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { createMemoryStorage, sampleFiles } from '../test/storage.js';

// Phase 6 at the database level: the storage buckets, the RLS rule for unsent uploads, the
// constraints that keep attachment rows consistent, and attachments in realtime payloads.

let t: TestDatabase;
let maya: string;
let jonas: string;
let outsider: string;
let conversationId: string;
let otherConversationId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  [maya, jonas, outsider] = [await t.createUser(), await t.createUser(), await t.createUser()];
  const conversations = createConversationStore(t.db);
  conversationId = (await conversations.create(maya, { type: 'direct', userId: jonas })).conversation.id;
  otherConversationId = (await conversations.create(maya, { type: 'direct', userId: outsider })).conversation.id;
});

afterAll(async () => {
  await t.close();
});

/** Inserts an attachment row directly (as the owner), with a valid path unless overridden. */
async function insertRow(o: {
  conversationId?: string;
  uploaderId?: string;
  messageId?: string | null;
  status?: 'pending' | 'ready';
  contentType?: string;
  fileName?: string;
  sizeBytes?: number;
  storagePath?: (id: string) => string;
  clientId?: string;
}) {
  const id = randomUUID();
  const conv = o.conversationId ?? conversationId;
  const uploader = o.uploaderId ?? maya;
  const path = o.storagePath ? o.storagePath(id) : `${conv}/${uploader}/${id}.pdf`;
  await t.client.query(
    `insert into message_attachments (id, conversation_id, message_id, uploader_id, client_id, status, storage_path, file_name, content_type, size_bytes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, conv, o.messageId ?? null, uploader, o.clientId ?? randomUUID(), o.status ?? 'ready', path, o.fileName ?? 'plan.pdf', o.contentType ?? 'application/pdf', o.sizeBytes ?? 2048],
  );
  return id;
}

async function insertMessage(conv = conversationId, sender = maya): Promise<string> {
  const { rows } = await t.client.query<{ id: string }>(
    "insert into messages (conversation_id, sender_id, type, content) values ($1, $2, 'attachment', null) returning id",
    [conv, sender],
  );
  return rows[0]!.id;
}

const visibleTo = (userId: string | null, id: string, role: 'anon' | 'authenticated' = 'authenticated') =>
  t.asRole(role, userId, async (tx) => (await tx.query('select 1 from message_attachments where id = $1', [id])).rows.length > 0);

describe('storage buckets', () => {
  it('creates both buckets private, with the same limits the API enforces', async () => {
    const { rows } = await t.client.query<{ id: string; public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      'select id, public, file_size_limit::int as file_size_limit, allowed_mime_types from storage.buckets order by id',
    );
    expect(rows.map((b) => ({ ...b, allowed_mime_types: [...b.allowed_mime_types].sort() }))).toEqual([
      { id: 'attachments', public: false, file_size_limit: MAX_FILE_BYTES, allowed_mime_types: [...ATTACHMENT_CONTENT_TYPES].sort() },
      { id: 'avatars', public: false, file_size_limit: MAX_AVATAR_BYTES, allowed_mime_types: [...AVATAR_CONTENT_TYPES].sort() },
    ]);
  });
});

describe('message_attachments RLS', () => {
  it('shows sent attachments to every member', async () => {
    const messageId = await insertMessage();
    const id = await insertRow({ messageId });
    expect(await visibleTo(maya, id)).toBe(true);
    expect(await visibleTo(jonas, id)).toBe(true);
  });

  it('shows an unsent upload only to its uploader', async () => {
    const id = await insertRow({ status: 'pending' });
    expect(await visibleTo(maya, id)).toBe(true);
    expect(await visibleTo(jonas, id)).toBe(false);
  });

  it('hides everything from outsiders and anonymous users', async () => {
    const id = await insertRow({ messageId: await insertMessage() });
    expect(await visibleTo(outsider, id)).toBe(false);
    expect(await visibleTo(null, id, 'anon')).toBe(false);
  });

  it('lets no browser role write attachment rows', async () => {
    const id = await insertRow({ status: 'pending' });
    const write = (sql: string, params: unknown[]) =>
      t.asRole('authenticated', maya, async (tx) => {
        try {
          const result = await tx.query(sql, params);
          return result.affectedRows ?? 0;
        } catch {
          return -1;
        }
      });
    expect(await write("update message_attachments set status = 'ready' where id = $1", [id])).toBeLessThanOrEqual(0);
    expect(await write('delete from message_attachments where id = $1', [id])).toBeLessThanOrEqual(0);
    expect(
      await write(
        `insert into message_attachments (conversation_id, uploader_id, client_id, storage_path, file_name, content_type, size_bytes)
         values ($1, $2, $3, 'x', 'a.pdf', 'application/pdf', 1)`,
        [conversationId, maya, randomUUID()],
      ),
    ).toBe(-1);
    const { rows } = await t.client.query<{ status: string }>('select status from message_attachments where id = $1', [id]);
    expect(rows[0]!.status).toBe('pending');
  });
});

describe('message_attachments constraints', () => {
  it('requires the path to be <conversation>/<uploader>/<own id>.<ext>', async () => {
    await expect(insertRow({ storagePath: (id) => `${otherConversationId}/${maya}/${id}.pdf` })).rejects.toThrow(/path_shape/);
    await expect(insertRow({ storagePath: (id) => `${conversationId}/${jonas}/${id}.pdf` })).rejects.toThrow(/path_shape/);
    await expect(insertRow({ storagePath: () => `${conversationId}/${maya}/${randomUUID()}.pdf` })).rejects.toThrow(/path_shape/);
    await expect(insertRow({ storagePath: (id) => `${conversationId}/${maya}/../${id}.pdf` })).rejects.toThrow(/path_shape/);
    await expect(insertRow({ storagePath: (id) => `${conversationId}/${maya}/${id}.pdf/x` })).rejects.toThrow(/path_shape/);
  });

  it('only lets a ready upload be attached to a message', async () => {
    await expect(insertRow({ status: 'pending', messageId: await insertMessage() })).rejects.toThrow(/attached_ready/);
  });

  it('never links an attachment to a message from another conversation', async () => {
    const elsewhere = await insertMessage(otherConversationId);
    await expect(insertRow({ messageId: elsewhere })).rejects.toThrow(/message_attachments_message_fk/);
  });

  it('allows only the supported types and sizes', async () => {
    await expect(insertRow({ contentType: 'text/html', fileName: 'x.html' })).rejects.toThrow(/content_type/);
    await expect(insertRow({ sizeBytes: MAX_FILE_BYTES + 1 })).rejects.toThrow(/size_limit/);
    await expect(insertRow({ sizeBytes: 0 })).rejects.toThrow(/size_positive/);
  });

  it('keeps one upload per (uploader, clientId)', async () => {
    const clientId = randomUUID();
    await insertRow({ clientId });
    await expect(insertRow({ clientId })).rejects.toThrow(/unique|duplicate/i);
  });

  it('deletes attachment rows with their message', async () => {
    const messageId = await insertMessage();
    const id = await insertRow({ messageId });
    await t.client.query('delete from messages where id = $1', [messageId]);
    expect((await t.client.query('select 1 from message_attachments where id = $1', [id])).rows).toEqual([]);
  });
});

describe('attachments in realtime payloads', () => {
  it('message.created and conversation.activity carry the attachments linked in the same transaction', async () => {
    const storage = createMemoryStorage();
    const attachments = createAttachmentStore(t.db, storage);
    const { response } = await attachments.start(maya, conversationId, {
      clientId: randomUUID(),
      fileName: 'beach.png',
      contentType: 'image/png',
      sizeBytes: sampleFiles.png().byteLength,
    });
    const { rows } = await t.client.query<{ storage_path: string }>('select storage_path from message_attachments where id = $1', [
      response.attachment.id,
    ]);
    storage.putObject('attachments', rows[0]!.storage_path, sampleFiles.png(), 'image/png');
    await attachments.complete(maya, response.attachment.id);
    const before = (await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT)).length;

    const { message } = await createMessageStore(t.db).create(maya, conversationId, {
      clientId: randomUUID(),
      attachmentIds: [response.attachment.id],
    });

    const created = await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT);
    expect(created).toHaveLength(before + 1);
    const payload = messageSchema.parse(created.at(-1)!.payload);
    expect(payload).toEqual(message);
    expect(payload.attachments).toEqual([
      { id: response.attachment.id, fileName: 'beach.png', contentType: 'image/png', sizeBytes: sampleFiles.png().byteLength },
    ]);
    expect(JSON.stringify(created.at(-1)!.payload)).not.toContain('storage');

    const activity = await t.broadcastsOn(userTopic(jonas), CONVERSATION_ACTIVITY_EVENT);
    expect(conversationActivityEventSchema.parse(activity.at(-1)!.payload).lastMessage.attachments).toHaveLength(1);
  });
});
