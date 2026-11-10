import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, MAX_FILE_BYTES, UPLOAD_DAILY_BYTES_LIMIT } from '@linka/shared';
import { createApp } from '../app.js';
import { createAttachmentStore } from '../services/attachments.js';
import { createConversationStore } from '../services/conversations.js';
import { createProfileStore } from '../services/profiles.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { createMemoryStorage, type MemoryStorage } from '../test/storage.js';

/**
 * Each user can upload at most UPLOAD_DAILY_BYTES_LIMIT of attachments in any 24 hours, so one
 * account cannot fill the project's storage. Checked when an upload starts, before anything is
 * stored; the declared size is what counts (completing an upload verifies it matches the file).
 */
let t: TestDatabase;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let storage: MemoryStorage;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestDatabase();
  auth = await createTestAuth();
});

beforeEach(() => {
  storage = createMemoryStorage();
  app = createApp({
    verifyAccessToken: auth.verifyAccessToken,
    profiles: createProfileStore(t.db),
    conversations: createConversationStore(t.db),
    attachments: createAttachmentStore(t.db, storage),
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

/** Starts uploading a PDF of `sizeBytes` (the largest allowed file is 25 MB). */
const startPdf = (who: User, conversationId: string, sizeBytes: number, clientId: string = randomUUID()) =>
  who.post(`/api/conversations/${conversationId}/attachments`, {
    clientId,
    fileName: 'notes.pdf',
    contentType: 'application/pdf',
    sizeBytes,
  });

async function uploadRows(userId: string): Promise<number> {
  const { rows } = await t.client.query<{ n: number }>('select count(*)::int as n from message_attachments where uploader_id = $1', [userId]);
  return rows[0]!.n;
}

describe('daily upload total', () => {
  it('is 50 MB per user', () => {
    expect(UPLOAD_DAILY_BYTES_LIMIT).toBe(50 * 1024 * 1024);
  });

  it('allows uploads up to the limit, then refuses the next one before anything is stored', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await direct(maya, jonas);

    expect((await startPdf(maya, conversation, MAX_FILE_BYTES)).status).toBe(201);
    expect((await startPdf(maya, conversation, UPLOAD_DAILY_BYTES_LIMIT - MAX_FILE_BYTES)).status).toBe(201);
    const uploadUrlsBefore = storage.uploadUrls.size;

    const refused = await startPdf(maya, conversation, 1);

    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe(ErrorCode.UploadQuotaExceeded);
    expect(refused.body.error.message).toBe('You have reached the daily upload limit of 50 MB. Try again later.');
    expect(await uploadRows(maya.id)).toBe(2);
    expect(storage.uploadUrls.size).toBe(uploadUrlsBefore);
  });

  it('counts uploads in every conversation together', async () => {
    const [maya, jonas, ana] = await Promise.all([user(), user(), user()]);
    const withJonas = await direct(maya, jonas);
    const withAna = await direct(maya, ana);

    await startPdf(maya, withJonas, MAX_FILE_BYTES);
    await startPdf(maya, withAna, MAX_FILE_BYTES);

    expect((await startPdf(maya, withJonas, 1)).status).toBe(429);
  });

  it('is per user: someone else can still upload', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await direct(maya, jonas);
    await startPdf(maya, conversation, MAX_FILE_BYTES);
    await startPdf(maya, conversation, MAX_FILE_BYTES);

    expect((await startPdf(jonas, conversation, MAX_FILE_BYTES)).status).toBe(201);
  });

  it('only counts the last 24 hours', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await direct(maya, jonas);
    await startPdf(maya, conversation, MAX_FILE_BYTES);
    await startPdf(maya, conversation, MAX_FILE_BYTES);
    await t.client.query(`update message_attachments set created_at = now() - interval '25 hours' where uploader_id = $1`, [maya.id]);

    expect((await startPdf(maya, conversation, MAX_FILE_BYTES)).status).toBe(201);
  });

  it('stops counting an upload once it is cancelled', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await direct(maya, jonas);
    const first = await startPdf(maya, conversation, MAX_FILE_BYTES);
    await startPdf(maya, conversation, MAX_FILE_BYTES);

    expect((await maya.delete(`/api/attachments/${first.body.attachment.id as string}`)).status).toBe(204);
    expect((await startPdf(maya, conversation, MAX_FILE_BYTES)).status).toBe(201);
  });

  it('never refuses a retry of an upload that was already counted', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await direct(maya, jonas);
    const clientId = randomUUID();
    await startPdf(maya, conversation, MAX_FILE_BYTES);
    expect((await startPdf(maya, conversation, MAX_FILE_BYTES, clientId)).status).toBe(201);

    const retry = await startPdf(maya, conversation, MAX_FILE_BYTES, clientId);

    expect(retry.status).toBe(200);
    expect(await uploadRows(maya.id)).toBe(2);
  });

  it('cannot be passed by starting two uploads at the same moment', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await direct(maya, jonas);
    await startPdf(maya, conversation, MAX_FILE_BYTES);

    const answers = await Promise.all([startPdf(maya, conversation, MAX_FILE_BYTES), startPdf(maya, conversation, MAX_FILE_BYTES)]);

    expect(answers.map((a) => a.status).sort()).toEqual([201, 429]);
    expect(await uploadRows(maya.id)).toBe(2);
  });
});
