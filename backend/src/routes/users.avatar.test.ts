import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_AVATAR_BYTES, profileSchema } from '@linka/shared';
import { createApp } from '../app.js';
import { createConversationStore } from '../services/conversations.js';
import { createMediaUrls } from '../services/media.js';
import { createProfileStore } from '../services/profiles.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { createMemoryStorage, sampleFiles, type MemoryStorage } from '../test/storage.js';

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
  const media = createMediaUrls(storage);
  app = createApp({
    verifyAccessToken: auth.verifyAccessToken,
    profiles: createProfileStore(t.db, media, storage),
    conversations: createConversationStore(t.db, media),
  });
});

afterAll(async () => {
  await t.close();
});

async function user(username?: string) {
  const id = await t.createUser(username);
  const authorization = `Bearer ${await auth.tokenFor(id)}`;
  return {
    id,
    putAvatar: (bytes: Uint8Array, contentType: string) =>
      request(app).put('/api/users/me/avatar').set('Authorization', authorization).set('Content-Type', contentType).send(Buffer.from(bytes)),
    get: (path: string) => request(app).get(path).set('Authorization', authorization),
    post: (path: string, body: object) => request(app).post(path).set('Authorization', authorization).send(body),
    delete: (path: string) => request(app).delete(path).set('Authorization', authorization),
  };
}

async function avatarPath(userId: string): Promise<string | null> {
  const { rows } = await t.client.query<{ avatar_path: string | null }>('select avatar_path from profiles where id = $1', [userId]);
  return rows[0]!.avatar_path;
}

describe('PUT /api/users/me/avatar', () => {
  it('stores the picture privately under the user’s folder and returns a signed URL', async () => {
    const maya = await user();

    const res = await maya.putAvatar(sampleFiles.png(), 'image/png');

    expect(res.status).toBe(200);
    const profile = profileSchema.parse(res.body);
    const path = await avatarPath(maya.id);
    expect(path).toMatch(new RegExp(`^${maya.id}/[0-9a-f-]{36}\\.png$`));
    expect(storage.has('avatars', path!)).toBe(true);
    expect(profile.avatarUrl).toBe(`https://storage.test/sign/avatars/${path}?expires=3600`);
    expect((await maya.get('/api/users/me')).body.avatarUrl).toBe(profile.avatarUrl);
  });

  it('replaces the previous picture and deletes the old file', async () => {
    const maya = await user();
    await maya.putAvatar(sampleFiles.png(), 'image/png');
    const first = await avatarPath(maya.id);

    expect((await maya.putAvatar(sampleFiles.jpeg(), 'image/jpeg')).status).toBe(200);

    const second = await avatarPath(maya.id);
    expect(second).toMatch(/\.jpg$/);
    expect(second).not.toBe(first);
    expect(storage.paths('avatars')).toEqual([second]);
  });

  it.each([
    ['an unsupported type', sampleFiles.pdf(), 'application/pdf', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['SVG (scriptable)', new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/svg+xml', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['a missing type', sampleFiles.png(), 'application/octet-stream', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['bytes that are not the claimed image', sampleFiles.exe(), 'image/png', 422, 'UPLOAD_REJECTED'],
    ['a JPEG labelled as PNG', sampleFiles.jpeg(), 'image/png', 422, 'UPLOAD_REJECTED'],
    ['an empty body', new Uint8Array(0), 'image/png', 400, 'VALIDATION_FAILED'],
  ])('rejects %s', async (_label, bytes, contentType, status, code) => {
    const maya = await user();
    const res = await maya.putAvatar(bytes, contentType);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(storage.paths('avatars')).toEqual([]);
    expect(await avatarPath(maya.id)).toBeNull();
  });

  it('rejects pictures over 2 MB before reading the whole body', async () => {
    const maya = await user();
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set(sampleFiles.png().slice(0, 8));
    const res = await maya.putAvatar(big, 'image/png');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('requires authentication and a profile', async () => {
    expect((await request(app).put('/api/users/me/avatar').set('Content-Type', 'image/png').send(Buffer.from(sampleFiles.png()))).status).toBe(401);
    const id = await t.createAuthUser();
    const res = await request(app)
      .put('/api/users/me/avatar')
      .set('Authorization', `Bearer ${await auth.tokenFor(id)}`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from(sampleFiles.png()));
    expect(res.status).toBe(404);
    expect(storage.paths('avatars')).toEqual([]);
  });

  it('answers 503 when storage is not configured, and leaves the profile alone when storage fails', async () => {
    const maya = await user();
    const unconfigured = createApp({ verifyAccessToken: auth.verifyAccessToken, profiles: createProfileStore(t.db) });
    const res = await request(unconfigured)
      .put('/api/users/me/avatar')
      .set('Authorization', `Bearer ${await auth.tokenFor(maya.id)}`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from(sampleFiles.png()));
    expect(res.status).toBe(503);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    storage.failNext('upload');
    expect((await maya.putAvatar(sampleFiles.png(), 'image/png')).status).toBe(500);
    expect(await avatarPath(maya.id)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('DELETE /api/users/me/avatar', () => {
  it('clears the picture and deletes the file', async () => {
    const maya = await user();
    await maya.putAvatar(sampleFiles.png(), 'image/png');

    const res = await maya.delete('/api/users/me/avatar');

    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBeNull();
    expect(await avatarPath(maya.id)).toBeNull();
    expect(storage.paths('avatars')).toEqual([]);
  });
});

describe('avatar URLs elsewhere', () => {
  it('appear in search results and conversation members, never as storage paths', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    await jonas.putAvatar(sampleFiles.png(), 'image/png');
    const jonasUsername = (await jonas.get('/api/users/me')).body.username as string;

    const search = await maya.get(`/api/users/search?q=${jonasUsername}`);
    expect(search.body.users[0].avatarUrl).toMatch(/^https:\/\/storage\.test\/sign\/avatars\//);

    const conversation = await maya.post('/api/conversations', { type: 'direct', userId: jonas.id });
    const member = conversation.body.members.find((m: { userId: string }) => m.userId === jonas.id);
    expect(member.avatarUrl).toMatch(/^https:\/\/storage\.test\/sign\/avatars\//);
    expect(JSON.stringify(conversation.body)).not.toContain('avatarPath');
  });

  it('fall back to no picture when signing fails', async () => {
    const maya = await user();
    await maya.putAvatar(sampleFiles.png(), 'image/png');
    storage.failNext('signedUrls');
    const res = await maya.get('/api/users/me');
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBeNull();
  });
});
