import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { RATE_LIMITS, type RateLimitConfig } from '../middleware/rateLimit.js';
import { createConversationStore } from '../services/conversations.js';
import { createMessageStore } from '../services/messages.js';
import { createProfileStore } from '../services/profiles.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// The API's rate limits with small numbers, so a few requests reach them. The clock is faked
// (only Date), so a window can be made to pass without waiting.

let t: TestDatabase;
let auth: Awaited<ReturnType<typeof createTestAuth>>;

beforeAll(async () => {
  t = await createTestDatabase();
  auth = await createTestAuth();
});

afterAll(async () => {
  await t.close();
});

afterEach(() => {
  vi.useRealTimers();
});

const small: RateLimitConfig = {
  ...RATE_LIMITS,
  unauthenticated: { limit: 2, windowMs: 60_000 },
  health: { limit: 2, windowMs: 60_000 },
  user: { limit: 8, windowMs: 60_000 },
  userSearch: { limit: 3, windowMs: 60_000 },
  sendMessage: { limit: 2, windowMs: 60_000 },
};

function app(rateLimits: RateLimitConfig = small) {
  return createApp({
    checkDatabase: async () => 'connected',
    verifyAccessToken: auth.verifyAccessToken,
    profiles: createProfileStore(t.db),
    conversations: createConversationStore(t.db),
    messages: createMessageStore(t.db),
    rateLimits,
  });
}

async function user(api: ReturnType<typeof app>) {
  const id = await t.createUser();
  const authorization = `Bearer ${await auth.tokenFor(id)}`;
  return {
    id,
    search: () => request(api).get('/api/users/search?q=us').set('Authorization', authorization),
    post: (path: string, body: object) => request(api).post(path).set('Authorization', authorization).send(body),
    get: (path: string) => request(api).get(path).set('Authorization', authorization),
  };
}

describe('per signed-in user', () => {
  it('allows requests within the limit, then answers 429 with Retry-After and the usual error shape', async () => {
    const api = app();
    const maya = await user(api);
    for (let i = 0; i < 3; i++) expect((await maya.search()).status).toBe(200);

    const refused = await maya.search();
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.stringMatching(/^Too many requests\. Try again in \d+ seconds?\.$/) } });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('counts each user on their own: one user’s limit never blocks another', async () => {
    const api = app();
    const [maya, jonas] = [await user(api), await user(api)];
    for (let i = 0; i < 4; i++) await maya.search();
    expect((await maya.search()).status).toBe(429);
    expect((await jonas.search()).status).toBe(200);
  });

  it('a limit on one action (search) leaves the user’s other requests alone', async () => {
    const api = app();
    const maya = await user(api);
    for (let i = 0; i < 4; i++) await maya.search();
    expect((await maya.get('/api/users/me')).status).toBe(200);
  });

  it('lets requests through again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T09:00:00Z'));
    const api = app();
    const maya = await user(api);
    for (let i = 0; i < 4; i++) await maya.search();
    expect((await maya.search()).status).toBe(429);

    vi.setSystemTime(new Date('2026-11-04T09:01:00Z'));
    expect((await maya.search()).status).toBe(200);
  });

  it('limits sending messages, without refusing the first ones', async () => {
    const api = app();
    const [maya, jonas] = [await user(api), await user(api)];
    const created = await maya.post('/api/conversations', { type: 'direct', userId: jonas.id });
    const path = `/api/conversations/${created.body.id}/messages`;
    const send = () => maya.post(path, { content: 'hi', clientId: randomUUID() });

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(429);
    // The limit is the sender's: Jonas can still answer.
    expect((await jonas.post(path, { content: 'hey', clientId: randomUUID() })).status).toBe(201);
  });

  it('has an overall limit across every route', async () => {
    const api = app();
    const maya = await user(api);
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await maya.get('/api/users/me')).status);
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses[8]).toBe(429);
  });
});

describe('without a valid sign-in (per IP address)', () => {
  it('answers 401 at first, then 429 for the same address', async () => {
    const api = app();
    expect((await request(api).get('/api/conversations')).status).toBe(401);
    expect((await request(api).get('/api/conversations').set('Authorization', 'Bearer not-a-token')).status).toBe(401);
    const refused = await request(api).get('/api/conversations');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not count signed-in requests from the same address against it', async () => {
    const api = app();
    for (let i = 0; i < 3; i++) await request(api).get('/api/conversations');
    const maya = await user(api);
    expect((await maya.get('/api/conversations')).status).toBe(200);
  });

  it('cannot be dodged with a made-up X-Forwarded-For header (no proxy is trusted by default)', async () => {
    const api = app();
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(api).get('/api/conversations').set('X-Forwarded-For', `203.0.113.${i}`)).status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('limits the public health check per address', async () => {
    const api = app();
    expect((await request(api).get('/api/health')).status).toBe(200);
    expect((await request(api).get('/api/health')).status).toBe(200);
    expect((await request(api).get('/api/health')).status).toBe(429);
  });
});

describe('the real limits', () => {
  it('do not get in the way of a normal burst of activity', async () => {
    const api = app(RATE_LIMITS);
    const [maya, jonas] = [await user(api), await user(api)];
    const created = await maya.post('/api/conversations', { type: 'direct', userId: jonas.id });
    const path = `/api/conversations/${created.body.id}/messages`;
    // Twenty messages in quick succession, a search per keystroke for a long username, reloads.
    for (let i = 0; i < 20; i++) expect((await maya.post(path, { content: `m${i}`, clientId: randomUUID() })).status).toBe(201);
    for (let i = 0; i < 12; i++) expect((await maya.search()).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await maya.get(path)).status).toBe(200);
  });
});
