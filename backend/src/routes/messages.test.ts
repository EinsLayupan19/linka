import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationListSchema, messagePageSchema, messageSchema, type Message } from '@linka/shared';
import { createApp } from '../app.js';
import { createConversationStore } from '../services/conversations.js';
import { createMessageStore } from '../services/messages.js';
import { createProfileStore } from '../services/profiles.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

let t: TestDatabase;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestDatabase();
  auth = await createTestAuth();
  app = createApp({
    verifyAccessToken: auth.verifyAccessToken,
    profiles: createProfileStore(t.db),
    conversations: createConversationStore(t.db),
    messages: createMessageStore(t.db),
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
    get: (path: string, query: Record<string, string | number> = {}) =>
      request(app).get(path).query(query).set('Authorization', authorization),
    post: (path: string, body?: object) => request(app).post(path).set('Authorization', authorization).send(body),
  };
}
type User = Awaited<ReturnType<typeof user>>;

async function directConversation(a: User, b: User): Promise<string> {
  const res = await a.post('/api/conversations', { type: 'direct', userId: b.id });
  return res.body.id as string;
}

const send = (from: User, conversationId: string, content: string, clientId: string = randomUUID()) =>
  from.post(`/api/conversations/${conversationId}/messages`, { content, clientId });

const messagesPath = (conversationId: string) => `/api/conversations/${conversationId}/messages`;

describe('POST /api/conversations/:id/messages', () => {
  it('stores the message with the token’s user as sender', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    const res = await send(maya, conversationId, 'Hello Jonas');

    expect(res.status).toBe(201);
    expect(messageSchema.parse(res.body)).toMatchObject({
      conversationId,
      senderId: maya.id,
      type: 'text',
      content: 'Hello Jonas',
    });
  });

  it('keeps the text exactly as typed', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    const res = await send(maya, conversationId, '  two\n  lines ');
    expect(res.body.content).toBe('  two\n  lines ');
  });

  it('rejects a spoofed sender instead of trusting it', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    const res = await maya.post(messagesPath(conversationId), {
      content: 'I am Jonas',
      clientId: randomUUID(),
      senderId: jonas.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\t '],
    ['longer than 4000 characters', 'x'.repeat(4001)],
  ])('rejects %s messages', async (_label, content) => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    const res = await send(maya, conversationId, content);
    expect(res.status).toBe(400);
    expect(res.body.error.fields.content).toBeDefined();
  });

  it('accepts exactly 4000 characters', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    expect((await send(maya, conversationId, 'x'.repeat(4000))).status).toBe(201);
  });

  it('refuses non-members with the same 404 as a missing conversation', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    for (const id of [conversationId, randomUUID(), 'not-a-uuid']) {
      const res = await send(outsider, id, 'Let me in');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
    }
    const { rows } = await t.client.query('select 1 from messages where conversation_id = $1', [conversationId]);
    expect(rows).toEqual([]);
  });

  it('requires authentication', async () => {
    const res = await request(app).post(messagesPath(randomUUID())).send({ content: 'hi', clientId: randomUUID() });
    expect(res.status).toBe(401);
  });

  it('treats a retry with the same clientId as the same message', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    const clientId = randomUUID();

    const first = await send(maya, conversationId, 'Only once', clientId);
    const retry = await send(maya, conversationId, 'Only once', clientId);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    const { rows } = await t.client.query('select count(*)::int as n from messages where conversation_id = $1', [conversationId]);
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('handles the same retry arriving twice at once', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    const clientId = randomUUID();

    const [a, b] = await Promise.all([send(maya, conversationId, 'Race', clientId), send(maya, conversationId, 'Race', clientId)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
  });

  it('lets different senders use the same clientId independently', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    const clientId = randomUUID();

    expect((await send(maya, conversationId, 'From Maya', clientId)).status).toBe(201);
    expect((await send(jonas, conversationId, 'From Jonas', clientId)).status).toBe(201);
  });

  it('refuses to reuse a clientId in another conversation', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const first = await directConversation(maya, jonas);
    const second = await directConversation(maya, priya);
    const clientId = randomUUID();

    await send(maya, first, 'Hi', clientId);
    expect((await send(maya, second, 'Hi', clientId)).status).toBe(409);
  });

  it('moves the conversation to the top of the list with a preview', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const older = await directConversation(maya, jonas);
    const newer = await directConversation(maya, priya);

    await send(maya, older, 'Bumped');

    const list = conversationListSchema.parse((await maya.get('/api/conversations')).body).conversations;
    expect(list.map((c) => c.id)).toEqual([older, newer]);
    expect(list[0]!.lastMessage).toMatchObject({ content: 'Bumped', senderId: maya.id });
    expect(list[1]!.lastMessage).toBeNull();
  });
});

describe('GET /api/conversations/:id/messages', () => {
  /** Inserts `count` messages; pairs of messages share a timestamp to exercise tie-breaking. */
  async function seed(conversationId: string, senderId: string, count: number) {
    for (let i = 0; i < count; i++) {
      const second = Math.floor(i / 2);
      await t.client.query(
        "insert into messages (conversation_id, sender_id, content, created_at) values ($1, $2, $3, timestamptz '2026-10-01T09:00:00Z' + make_interval(secs => $4))",
        [conversationId, senderId, `message ${i}`, second],
      );
    }
  }

  async function allPages(reader: User, conversationId: string, limit: number) {
    const pages: Message[][] = [];
    let before: string | null = null;
    do {
      const res = await reader.get(messagesPath(conversationId), before ? { limit, before } : { limit });
      expect(res.status).toBe(200);
      const page = messagePageSchema.parse(res.body);
      pages.push(page.messages);
      before = page.nextCursor;
    } while (before);
    return pages;
  }

  it('returns the newest page first, oldest-to-newest within the page', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    await seed(conversationId, maya.id, 7);

    const page = messagePageSchema.parse((await jonas.get(messagesPath(conversationId), { limit: 3 })).body);
    // Messages 4 and 5 share a timestamp, so their order is by (random) id; 6 is newest.
    expect(new Set(page.messages.map((m) => m.content))).toEqual(new Set(['message 4', 'message 5', 'message 6']));
    expect(page.messages.at(-1)?.content).toBe('message 6');
    const [a, b] = page.messages;
    expect(a!.createdAt === b!.createdAt && a!.id < b!.id).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it('walks the whole history with cursors: no gaps, no repeats, despite identical timestamps', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    await seed(conversationId, maya.id, 11);

    const pages = await allPages(jonas, conversationId, 3);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 3, 2]);

    const all = pages.reverse().flat();
    // Every message exactly once.
    expect(new Set(all.map((m) => m.id)).size).toBe(11);
    expect(new Set(all.map((m) => m.content))).toEqual(new Set(Array.from({ length: 11 }, (_, i) => `message ${i}`)));
    // Deterministic order: (createdAt, id) strictly increasing across page boundaries,
    // so ties on createdAt are ordered by id rather than by chance.
    for (let i = 1; i < all.length; i++) {
      const [a, b] = [all[i - 1]!, all[i]!];
      expect(a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id)).toBe(true);
    }
    expect(all.filter((m, i) => i > 0 && m.createdAt === all[i - 1]!.createdAt).length).toBeGreaterThan(0);
  });

  it('returns the same order every time', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    await seed(conversationId, maya.id, 6);

    const first = (await jonas.get(messagesPath(conversationId))).body.messages.map((m: Message) => m.id);
    const second = (await jonas.get(messagesPath(conversationId))).body.messages.map((m: Message) => m.id);
    expect(second).toEqual(first);
  });

  it('defaults to 50 messages per page', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    await seed(conversationId, maya.id, 55);

    const page = messagePageSchema.parse((await jonas.get(messagesPath(conversationId))).body);
    expect(page.messages).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
  });

  it('has no cursor when everything fits on one page, and handles empty conversations', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    await seed(conversationId, maya.id, 2);
    const empty = await directConversation(maya, priya);

    expect((await jonas.get(messagesPath(conversationId))).body.nextCursor).toBeNull();
    expect((await maya.get(messagesPath(empty))).body).toEqual({ messages: [], nextCursor: null });
  });

  it.each([['0'], ['101'], ['-1'], ['ten'], ['1.5']])('rejects limit=%s', async (limit) => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    const res = await maya.get(messagesPath(conversationId), { limit });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.limit).toBeDefined();
  });

  it.each([
    ['not base64 JSON', 'garbage!!'],
    ['the wrong shape', Buffer.from(JSON.stringify({ id: 1 })).toString('base64url')],
    ['a bad timestamp', Buffer.from(JSON.stringify(['yesterday', randomUUID()])).toString('base64url')],
    ['a bad id', Buffer.from(JSON.stringify(['2026-10-01T09:00:00.000Z', '42'])).toString('base64url')],
  ])('rejects a cursor with %s', async (_label, before) => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    const res = await maya.get(messagesPath(conversationId), { before });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ before: 'Invalid cursor.' });
  });

  it('cannot read another conversation by pairing its id with a valid cursor', async () => {
    const [maya, jonas, outsider, friend] = await Promise.all([user(), user(), user(), user()]);
    const theirs = await directConversation(maya, jonas);
    await seed(theirs, maya.id, 4);
    const cursor = (await maya.get(messagesPath(theirs), { limit: 2 })).body.nextCursor as string;
    await directConversation(outsider, friend);

    const res = await outsider.get(messagesPath(theirs), { before: cursor });
    expect(res.status).toBe(404);
  });

  it('refuses non-members and unauthenticated requests', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const conversationId = await directConversation(maya, jonas);

    expect((await outsider.get(messagesPath(conversationId))).status).toBe(404);
    expect((await request(app).get(messagesPath(conversationId))).status).toBe(401);
  });

  it('is private and uncacheable', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await directConversation(maya, jonas);
    expect((await maya.get(messagesPath(conversationId))).headers['cache-control']).toBe('private, no-store');
  });
});
