import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentUploadResponseSchema, messageSchema, UNATTACHED_UPLOAD_TTL_HOURS } from '@linka/shared';
import { createApp } from '../app.js';
import { createAttachmentStore, type AttachmentStore } from '../services/attachments.js';
import { createConversationStore } from '../services/conversations.js';
import { createMarkerStore } from '../services/markers.js';
import { createMessageStore } from '../services/messages.js';
import { createProfileStore } from '../services/profiles.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { createMemoryStorage, sampleFiles, type MemoryStorage } from '../test/storage.js';

let t: TestDatabase;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let storage: MemoryStorage;
let attachments: AttachmentStore;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestDatabase();
  auth = await createTestAuth();
});

beforeEach(() => {
  storage = createMemoryStorage();
  attachments = createAttachmentStore(t.db, storage);
  app = createApp({
    verifyAccessToken: auth.verifyAccessToken,
    profiles: createProfileStore(t.db),
    conversations: createConversationStore(t.db),
    messages: createMessageStore(t.db),
    markers: createMarkerStore(t.db),
    attachments,
  });
});

afterAll(async () => {
  await t.close();
});

async function user() {
  const id = await t.createUser();
  const authorization = `Bearer ${await auth.tokenFor(id)}`;
  return {
    id,
    post: (path: string, body?: object) => request(app).post(path).set('Authorization', authorization).send(body),
    delete: (path: string) => request(app).delete(path).set('Authorization', authorization),
  };
}
type User = Awaited<ReturnType<typeof user>>;

async function direct(a: User, b: User): Promise<string> {
  return (await a.post('/api/conversations', { type: 'direct', userId: b.id })).body.id as string;
}

const png = (overrides: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  fileName: 'beach.png',
  contentType: 'image/png',
  sizeBytes: sampleFiles.png().byteLength,
  ...overrides,
});

/** Starts an upload, "uploads" `bytes` to the path the server chose, and completes it. */
async function uploadFile(who: User, conversationId: string, bytes = sampleFiles.png(), file = png({ sizeBytes: bytes.byteLength })) {
  const started = await who.post(`/api/conversations/${conversationId}/attachments`, file);
  expect(started.status).toBe(201);
  const { attachment } = attachmentUploadResponseSchema.parse(started.body);
  storage.putObject('attachments', await pathOf(attachment.id), bytes, file.contentType as string);
  const completed = await who.post(`/api/attachments/${attachment.id}/complete`);
  return { id: attachment.id, completed };
}

async function pathOf(attachmentId: string): Promise<string> {
  const { rows } = await t.client.query<{ storage_path: string }>('select storage_path from message_attachments where id = $1', [attachmentId]);
  return rows[0]!.storage_path;
}

describe('starting an upload', () => {
  it('creates a pending upload at a server-chosen path and returns a signed upload URL', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);

    const res = await maya.post(`/api/conversations/${conversationId}/attachments`, png());

    expect(res.status).toBe(201);
    const body = attachmentUploadResponseSchema.parse(res.body);
    expect(body.attachment).toMatchObject({ conversationId, fileName: 'beach.png', status: 'pending' });
    expect(body.upload?.url).toMatch(/^https:\/\/storage\.test\/upload\/attachments\//);
    const path = await pathOf(body.attachment.id);
    expect(path).toBe(`${conversationId}/${maya.id}/${body.attachment.id}.png`);
    // The attachment record never carries the path (the signed upload URL necessarily embeds it).
    expect(Object.keys(res.body.attachment).sort()).toEqual(['contentType', 'conversationId', 'fileName', 'id', 'sizeBytes', 'status']);
  });

  it('treats a retry with the same clientId as the same upload', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const file = png();

    const first = await maya.post(`/api/conversations/${conversationId}/attachments`, file);
    const retry = await maya.post(`/api/conversations/${conversationId}/attachments`, file);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.attachment.id).toBe(first.body.attachment.id);
    expect(retry.body.upload).not.toBeNull();
  });

  it('requires authentication and membership', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const conversationId = await direct(maya, jonas);

    expect((await request(app).post(`/api/conversations/${conversationId}/attachments`).send(png())).status).toBe(401);
    const res = await outsider.post(`/api/conversations/${conversationId}/attachments`, png());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it.each([
    ['an unsupported type', { contentType: 'image/svg+xml', fileName: 'logo.svg' }],
    ['an HTML file', { contentType: 'text/html', fileName: 'page.html' }],
    ['an extension that does not match the type', { fileName: 'beach.exe' }],
    ['an empty file', { sizeBytes: 0 }],
    ['an oversized image', { sizeBytes: 10 * 1024 * 1024 + 1 }],
    ['a path-traversal name', { fileName: '../../avatars/x.png' }],
    ['a backslash path name', { fileName: '..\\..\\x.png' }],
    ['a control character in the name', { fileName: 'be\u0000ach.png' }],
    ['a fractional size', { sizeBytes: 12.5 }],
    ['a missing client id', { clientId: undefined }],
    ['a client-chosen storage path', { storagePath: 'other/user/file.png' }],
    ['a spoofed uploader', { uploaderId: randomUUID() }],
  ])('rejects %s', async (_label, overrides) => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);

    const res = await maya.post(`/api/conversations/${conversationId}/attachments`, png(overrides));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const { rows } = await t.client.query('select 1 from message_attachments where conversation_id = $1', [conversationId]);
    expect(rows).toEqual([]);
  });

  it('answers 503 without leaking details when storage is not configured or fails', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);

    const noStorage = createApp({ verifyAccessToken: auth.verifyAccessToken, attachments: createAttachmentStore(t.db, null) });
    const unconfigured = await request(noStorage)
      .post(`/api/conversations/${conversationId}/attachments`)
      .set('Authorization', `Bearer ${await auth.tokenFor(maya.id)}`)
      .send(png());
    expect(unconfigured.status).toBe(503);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    storage.failNext('createUploadUrl');
    const res = await maya.post(`/api/conversations/${conversationId}/attachments`, png());
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
    vi.restoreAllMocks();
  });
});

describe('completing an upload', () => {
  it('marks a verified upload ready', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const { completed } = await uploadFile(maya, await direct(maya, jonas));

    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('ready');
  });

  it('says when nothing has been uploaded yet', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const started = await maya.post(`/api/conversations/${conversationId}/attachments`, png());

    const res = await maya.post(`/api/attachments/${started.body.attachment.id}/complete`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPLOAD_INCOMPLETE');
  });

  it('rejects and discards a file whose bytes are not what it claims (never trusting the MIME type)', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const exe = sampleFiles.exe();

    const { id, completed } = await uploadFile(maya, conversationId, exe, png({ sizeBytes: exe.byteLength }));

    expect(completed.status).toBe(422);
    expect(completed.body.error).toEqual({ code: 'UPLOAD_REJECTED', message: 'The file content does not match its type.' });
    expect(storage.paths('attachments')).toEqual([]);
    const { rows } = await t.client.query('select 1 from message_attachments where id = $1', [id]);
    expect(rows).toEqual([]);
  });

  it('compares only the media type of what Storage recorded, and rejects a different type', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const text = sampleFiles.text();
    const file = { clientId: randomUUID(), fileName: 'notes.txt', contentType: 'text/plain', sizeBytes: text.byteLength };

    const started = await maya.post(`/api/conversations/${conversationId}/attachments`, file);
    storage.putObject('attachments', await pathOf(started.body.attachment.id), text, 'text/plain;charset=UTF-8');
    expect((await maya.post(`/api/attachments/${started.body.attachment.id}/complete`)).body.status).toBe('ready');

    const other = await maya.post(`/api/conversations/${conversationId}/attachments`, { ...file, clientId: randomUUID() });
    storage.putObject('attachments', await pathOf(other.body.attachment.id), text, 'text/html');
    const res = await maya.post(`/api/attachments/${other.body.attachment.id}/complete`);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('The uploaded file does not have the declared type.');
  });

  it('rejects an upload whose size differs from what was declared', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const { completed } = await uploadFile(maya, conversationId, sampleFiles.png(), png({ sizeBytes: 999 }));
    expect(completed.status).toBe(422);
    expect(storage.paths('attachments')).toEqual([]);
  });

  it('only lets the uploader complete it', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const started = await maya.post(`/api/conversations/${conversationId}/attachments`, png());

    const res = await jonas.post(`/api/attachments/${started.body.attachment.id}/complete`);
    expect(res.status).toBe(404);
    expect((await jonas.post('/api/attachments/not-a-uuid/complete')).status).toBe(404);
  });
});

describe('sending attachments', () => {
  const sendWith = (who: User, conversationId: string, attachmentIds: string[], content?: string, clientId = randomUUID()) =>
    who.post(`/api/conversations/${conversationId}/messages`, { clientId, attachmentIds, ...(content ? { content } : {}) });

  it('sends a message with attachments and an optional caption', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const a = await uploadFile(maya, conversationId);
    const b = await uploadFile(maya, conversationId, sampleFiles.pdf(), {
      clientId: randomUUID(),
      fileName: 'plan.pdf',
      contentType: 'application/pdf',
      sizeBytes: sampleFiles.pdf().byteLength,
    });

    const res = await sendWith(maya, conversationId, [a.id, b.id], 'Trip photos');

    expect(res.status).toBe(201);
    const message = messageSchema.parse(res.body);
    expect(message).toMatchObject({ type: 'attachment', content: 'Trip photos', senderId: maya.id });
    expect(message.attachments.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(JSON.stringify(res.body)).not.toContain('storage');
  });

  it('allows attachments without text', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const a = await uploadFile(maya, conversationId);
    const res = await sendWith(maya, conversationId, [a.id]);
    expect(res.status).toBe(201);
    expect(res.body.content).toBeNull();
  });

  it('a retried send returns the same message and does not re-link anything', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const a = await uploadFile(maya, conversationId);
    const clientId = randomUUID();

    const first = await sendWith(maya, conversationId, [a.id], undefined, clientId);
    const retry = await sendWith(maya, conversationId, [a.id], undefined, clientId);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.attachments).toEqual(first.body.attachments);
  });

  it.each([
    ['another user’s upload', 'other'],
    ['an upload from another conversation', 'elsewhere'],
    ['an upload that is not finished', 'pending'],
    ['an attachment that was already sent', 'sent'],
    ['an attachment that does not exist', 'missing'],
  ])('refuses %s', async (_label, kind) => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const conversationId = await direct(maya, jonas);
    let attachmentId: string;
    if (kind === 'other') attachmentId = (await uploadFile(jonas, conversationId)).id;
    else if (kind === 'elsewhere') attachmentId = (await uploadFile(maya, await direct(maya, priya))).id;
    else if (kind === 'pending') attachmentId = (await maya.post(`/api/conversations/${conversationId}/attachments`, png())).body.attachment.id;
    else if (kind === 'sent') {
      attachmentId = (await uploadFile(maya, conversationId)).id;
      await sendWith(maya, conversationId, [attachmentId]);
    } else attachmentId = randomUUID();

    const res = await sendWith(maya, conversationId, [attachmentId], 'Look');
    expect(res.status).toBe(400);
    expect(res.body.error.fields.attachmentIds).toBeDefined();
    // Nothing was stored for the refused send.
    const { rows } = await t.client.query("select 1 from messages where conversation_id = $1 and content = 'Look'", [conversationId]);
    expect(rows).toEqual([]);
  });

  it('lets only one of two different sends claim the same upload', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const { id } = await uploadFile(maya, conversationId);

    const results = await Promise.all([sendWith(maya, conversationId, [id], 'one'), sendWith(maya, conversationId, [id], 'two')]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const { rows } = await t.client.query('select message_id from message_attachments where id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('rejects more than 10 attachments', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const res = await sendWith(maya, conversationId, Array.from({ length: 11 }, () => randomUUID()));
    expect(res.status).toBe(400);
  });

  it('keeps text-only messages working as before', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const res = await maya.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), content: 'Plain text' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'text', attachments: [] });
  });
});

describe('cancelling an upload', () => {
  it('deletes the caller’s unsent upload and its file', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const { id } = await uploadFile(maya, conversationId);

    expect((await maya.delete(`/api/attachments/${id}`)).status).toBe(204);
    expect(storage.paths('attachments')).toEqual([]);
    expect((await maya.post(`/api/attachments/${id}/complete`)).status).toBe(404);
  });

  it('refuses for other users and for sent attachments', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const { id } = await uploadFile(maya, conversationId);

    expect((await jonas.delete(`/api/attachments/${id}`)).status).toBe(404);
    await maya.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), attachmentIds: [id] });
    const res = await maya.delete(`/api/attachments/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTACHMENT_IN_USE');
    expect(storage.paths('attachments')).toHaveLength(1);
  });
});

describe('viewing attachments', () => {
  it('gives members short-lived URLs for sent attachments, and nothing to anyone else', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const conversationId = await direct(maya, jonas);
    const { id } = await uploadFile(maya, conversationId);
    await maya.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), attachmentIds: [id] });

    const forJonas = await jonas.post('/api/attachments/urls', { attachmentIds: [id] });
    expect(forJonas.status).toBe(200);
    expect(forJonas.body.urls).toEqual([{ id, url: expect.stringContaining('expires=600'), expiresAt: expect.any(String) }]);

    const forOutsider = await outsider.post('/api/attachments/urls', { attachmentIds: [id] });
    expect(forOutsider.body.urls).toEqual([]);
  });

  it('shows an unsent upload only to its uploader', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const { id } = await uploadFile(maya, conversationId);

    expect((await maya.post('/api/attachments/urls', { attachmentIds: [id] })).body.urls).toHaveLength(1);
    expect((await jonas.post('/api/attachments/urls', { attachmentIds: [id] })).body.urls).toEqual([]);
  });

  it('stops working for someone who left the conversation', async () => {
    const [owner, member] = await Promise.all([user(), user()]);
    const group = (await owner.post('/api/conversations', { type: 'group', name: 'G', memberIds: [member.id] })).body.id as string;
    const { id } = await uploadFile(owner, group);
    await owner.post(`/api/conversations/${group}/messages`, { clientId: randomUUID(), attachmentIds: [id] });
    await member.delete(`/api/conversations/${group}/members/${member.id}`);

    expect((await member.post('/api/attachments/urls', { attachmentIds: [id] })).body.urls).toEqual([]);
  });

  it('validates the request', async () => {
    const maya = await user();
    expect((await maya.post('/api/attachments/urls', { attachmentIds: ['../../etc'] })).status).toBe(400);
    expect((await maya.post('/api/attachments/urls', { attachmentIds: [] })).status).toBe(400);
    expect((await request(app).post('/api/attachments/urls').send({ attachmentIds: [randomUUID()] })).status).toBe(401);
  });
});

describe('cleanup of unsent uploads', () => {
  it('removes old unsent uploads (row, then file) and keeps sent and recent ones', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const old = await uploadFile(maya, conversationId);
    const recent = await uploadFile(maya, conversationId);
    const sent = await uploadFile(maya, conversationId);
    await maya.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), attachmentIds: [sent.id] });
    await t.client.query(`update message_attachments set created_at = now() - interval '${UNATTACHED_UPLOAD_TTL_HOURS + 1} hours' where id = any($1)`, [
      [old.id, sent.id],
    ]);
    const oldPath = await pathOf(old.id);
    const sentPath = await pathOf(sent.id);

    const removed = await attachments.sweepUnattached();

    expect(removed).toBe(1);
    expect(storage.has('attachments', oldPath)).toBe(false);
    expect(storage.has('attachments', sentPath)).toBe(true);
    const { rows } = await t.client.query<{ id: string }>('select id from message_attachments where id = any($1) order by id', [
      [old.id, recent.id, sent.id],
    ]);
    expect(rows.map((r) => r.id).sort()).toEqual([recent.id, sent.id].sort());
  });

  it('also removes abandoned pending uploads that never received a file', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const started = await maya.post(`/api/conversations/${conversationId}/attachments`, png());
    await t.client.query(`update message_attachments set created_at = now() - interval '2 days' where id = $1`, [started.body.attachment.id]);

    expect(await attachments.sweepUnattached()).toBe(1);
  });
});
