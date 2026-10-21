import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userSearchResultSchema } from '@linka/shared';
import { createApp } from '../app.js';
import { createProfileStore } from '../services/profiles.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

let t: TestDatabase;
let app: ReturnType<typeof createApp>;
let authorization: string;
let me: string;

beforeAll(async () => {
  t = await createTestDatabase();
  const auth = await createTestAuth();
  app = createApp({ verifyAccessToken: auth.verifyAccessToken, profiles: createProfileStore(t.db) });

  me = await t.createUser('searcher');
  authorization = `Bearer ${await auth.tokenFor(me)}`;
  for (const username of ['maya', 'maya_reyes', 'mayank', 'jonas', 'm_a', 'ma_ya']) await t.createUser(username);
  for (let i = 0; i < 25; i++) await t.createUser(`many_${String(i).padStart(2, '0')}`);
});

afterAll(async () => {
  await t.close();
});

const search = (q?: string) =>
  request(app)
    .get('/api/users/search')
    .query(q === undefined ? {} : { q })
    .set('Authorization', authorization);

const usernames = (body: unknown) => userSearchResultSchema.parse(body).users.map((u) => u.username);

describe('GET /api/users/search', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/users/search').query({ q: 'maya' })).status).toBe(401);
  });

  it('matches usernames by prefix, exact match first', async () => {
    const res = await search('maya');
    expect(res.status).toBe(200);
    expect(usernames(res.body)).toEqual(['maya', 'maya_reyes', 'mayank']);
  });

  it('is case-insensitive', async () => {
    expect(usernames((await search('MaYa')).body)).toEqual(['maya', 'maya_reyes', 'mayank']);
  });

  it('only matches prefixes, not anywhere in the name', async () => {
    expect(usernames((await search('reyes')).body)).toEqual([]);
  });

  it('treats LIKE wildcards literally, so "%" or "_" cannot dump users', async () => {
    expect(usernames((await search('%%')).body)).toEqual([]);
    // "_" matches only a literal underscore: "m_" finds "m_a", not "maya".
    expect(usernames((await search('m_')).body)).toEqual(['m_a']);
  });

  it('caps the number of results', async () => {
    expect(usernames((await search('many')).body)).toHaveLength(20);
  });

  it('never returns the caller', async () => {
    expect(usernames((await search('searcher')).body)).toEqual([]);
  });

  it('returns public fields only, never email', async () => {
    const res = await search('jonas');
    expect(Object.keys(res.body.users[0]).sort()).toEqual(['avatarPath', 'displayName', 'id', 'username']);
    expect(JSON.stringify(res.body)).not.toContain('@');
  });

  it('requires at least 2 characters', async () => {
    const short = await search('m');
    expect(short.status).toBe(400);
    expect(short.body.error.fields).toEqual({ q: 'Type at least 2 characters.' });
    expect((await search()).status).toBe(400);
  });

  it('rejects repeated query parameters', async () => {
    const res = await request(app).get('/api/users/search?q=ma&q=jo').set('Authorization', authorization);
    expect(res.status).toBe(400);
  });
});
