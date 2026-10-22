import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationListSchema, conversationSchema, type Conversation } from '@linka/shared';
import { createApp } from '../app.js';
import { createConversationStore } from '../services/conversations.js';
import { createMarkerStore } from '../services/markers.js';
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
    markers: createMarkerStore(t.db),
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
    get: (path: string) => request(app).get(path).set('Authorization', authorization),
    post: (path: string, body?: object) => request(app).post(path).set('Authorization', authorization).send(body),
    put: (path: string, body?: object) => request(app).put(path).set('Authorization', authorization).send(body),
  };
}
type User = Awaited<ReturnType<typeof user>>;

async function direct(a: User, b: User): Promise<string> {
  return (await a.post('/api/conversations', { type: 'direct', userId: b.id })).body.id as string;
}

async function send(from: User, conversationId: string, content = 'hi'): Promise<{ id: string; createdAt: string }> {
  const res = await from.post(`/api/conversations/${conversationId}/messages`, { content, clientId: randomUUID() });
  expect(res.status).toBe(201);
  return res.body;
}

async function markersOf(conversationId: string, userId: string) {
  const { rows } = await t.client.query<{ last_read_at: Date | null; last_delivered_at: Date | null }>(
    'select last_read_at, last_delivered_at from conversation_members where conversation_id = $1 and user_id = $2',
    [conversationId, userId],
  );
  return rows[0]!;
}

const read = (who: User, conversationId: string, lastReadAt: string) =>
  who.put(`/api/conversations/${conversationId}/read`, { lastReadAt });

const unreadOf = async (who: User, conversationId: string) =>
  conversationSchema.parse((await who.get(`/api/conversations/${conversationId}`)).body).unreadCount;

describe('PUT /api/conversations/:id/read', () => {
  it('advances the caller’s own read marker, and delivery with it', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    const message = await send(maya, id);

    const res = await read(jonas, id, message.createdAt);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conversationId: id, lastReadAt: message.createdAt, lastDeliveredAt: message.createdAt });
    expect((await markersOf(id, jonas.id)).last_read_at?.toISOString()).toBe(message.createdAt);
    // Nobody else's marker moved.
    expect((await markersOf(id, maya.id)).last_read_at).toBeNull();
  });

  it('rejects moving the marker backwards, and treats the same value as a no-op', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    const first = await send(maya, id, 'one');
    const second = await send(maya, id, 'two');
    await read(jonas, id, second.createdAt);

    const backwards = await read(jonas, id, first.createdAt);
    expect(backwards.status).toBe(409);
    expect(backwards.body.error.code).toBe('MARKER_BEHIND');
    expect((await markersOf(id, jonas.id)).last_read_at?.toISOString()).toBe(second.createdAt);

    expect((await read(jonas, id, second.createdAt)).status).toBe(200);
  });

  it('rejects marking messages that do not exist yet as read', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    const message = await send(maya, id);
    const future = new Date(new Date(message.createdAt).getTime() + 60_000).toISOString();

    const res = await read(jonas, id, future);
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ lastReadAt: 'This is later than the newest message.' });
  });

  it('rejects read markers in a conversation without messages', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    expect((await read(jonas, id, new Date().toISOString())).status).toBe(400);
  });

  it.each(['yesterday', '', '2026-13-40T99:00:00Z', 42])('rejects the malformed timestamp %j', async (lastReadAt) => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    await send(maya, id);

    const res = await jonas.put(`/api/conversations/${id}/read`, { lastReadAt });
    expect(res.status).toBe(400);
  });

  it('cannot target another member: a userId in the body is rejected', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    const message = await send(jonas, id);

    const res = await jonas.put(`/api/conversations/${id}/read`, { lastReadAt: message.createdAt, userId: maya.id });
    expect(res.status).toBe(400);
    expect((await markersOf(id, maya.id)).last_read_at).toBeNull();
  });

  it('refuses non-members and unauthenticated callers', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const id = await direct(maya, jonas);
    const message = await send(maya, id);

    expect((await read(outsider, id, message.createdAt)).status).toBe(404);
    expect((await request(app).put(`/api/conversations/${id}/read`).send({ lastReadAt: message.createdAt })).status).toBe(401);
  });
});

describe('POST /api/conversations/delivered', () => {
  it('advances delivery markers for several conversations in one request', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const one = await direct(jonas, maya);
    const two = await direct(priya, maya);
    const a = await send(jonas, one);
    const b = await send(priya, two);

    const res = await maya.post('/api/conversations/delivered', {
      conversations: [
        { conversationId: one, lastDeliveredAt: a.createdAt },
        { conversationId: two, lastDeliveredAt: b.createdAt },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.updated.map((u: { conversationId: string }) => u.conversationId).sort()).toEqual([one, two].sort());
    expect((await markersOf(one, maya.id)).last_delivered_at?.toISOString()).toBe(a.createdAt);
    expect((await markersOf(two, maya.id)).last_delivered_at?.toISOString()).toBe(b.createdAt);
    expect((await markersOf(one, maya.id)).last_read_at).toBeNull();
  });

  it('never moves a delivery marker backwards (stale values are skipped)', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(jonas, maya);
    const first = await send(jonas, id, 'one');
    const second = await send(jonas, id, 'two');
    await maya.post('/api/conversations/delivered', { conversations: [{ conversationId: id, lastDeliveredAt: second.createdAt }] });

    const res = await maya.post('/api/conversations/delivered', {
      conversations: [{ conversationId: id, lastDeliveredAt: first.createdAt }],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect((await markersOf(id, maya.id)).last_delivered_at?.toISOString()).toBe(second.createdAt);
  });

  it('uses the newest time when a conversation appears twice', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(jonas, maya);
    const first = await send(jonas, id, 'one');
    const second = await send(jonas, id, 'two');

    await maya.post('/api/conversations/delivered', {
      conversations: [
        { conversationId: id, lastDeliveredAt: second.createdAt },
        { conversationId: id, lastDeliveredAt: first.createdAt },
      ],
    });
    expect((await markersOf(id, maya.id)).last_delivered_at?.toISOString()).toBe(second.createdAt);
  });

  it('rejects the whole batch if any conversation is not the caller’s', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const mine = await direct(jonas, maya);
    const theirs = await direct(jonas, outsider);
    const a = await send(jonas, mine);
    const b = await send(jonas, theirs);

    const res = await maya.post('/api/conversations/delivered', {
      conversations: [
        { conversationId: mine, lastDeliveredAt: a.createdAt },
        { conversationId: theirs, lastDeliveredAt: b.createdAt },
      ],
    });
    expect(res.status).toBe(404);
    expect((await markersOf(mine, maya.id)).last_delivered_at).toBeNull();
  });

  it('rejects times later than the newest message', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(jonas, maya);
    await send(jonas, id);

    const res = await maya.post('/api/conversations/delivered', {
      conversations: [{ conversationId: id, lastDeliveredAt: '2099-01-01T00:00:00.000Z' }],
    });
    expect(res.status).toBe(400);
  });

  it('cannot move another member’s marker', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(jonas, maya);
    const message = await send(maya, id);

    const res = await maya.post('/api/conversations/delivered', {
      conversations: [{ conversationId: id, lastDeliveredAt: message.createdAt, userId: jonas.id }],
    });
    expect(res.status).toBe(400);
    expect((await markersOf(id, jonas.id)).last_delivered_at).toBeNull();
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/conversations/delivered').send({ conversations: [] })).status).toBe(401);
  });
});

describe('unread counts', () => {
  it('counts other people’s messages after the read marker, never your own', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    await send(maya, id, 'from maya 1');
    await send(maya, id, 'from maya 2');
    await send(jonas, id, 'from jonas');

    expect(await unreadOf(jonas, id)).toBe(2);
    expect(await unreadOf(maya, id)).toBe(1);
  });

  it('drops to zero after reading, and only counts what came after the marker', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    const first = await send(maya, id, 'one');
    await send(maya, id, 'two');
    const third = await send(maya, id, 'three');

    await read(jonas, id, first.createdAt);
    expect(await unreadOf(jonas, id)).toBe(2);

    await read(jonas, id, third.createdAt);
    expect(await unreadOf(jonas, id)).toBe(0);
  });

  it('works per member in groups', async () => {
    const [owner, a, b] = await Promise.all([user(), user(), user()]);
    const group = (await owner.post('/api/conversations', { type: 'group', name: 'G', memberIds: [a.id, b.id] })).body as Conversation;
    await send(owner, group.id, 'hello');
    const last = await send(a, group.id, 'hi all');
    await read(b, group.id, last.createdAt);

    expect(await unreadOf(owner, group.id)).toBe(1);
    expect(await unreadOf(a, group.id)).toBe(1);
    expect(await unreadOf(b, group.id)).toBe(0);
  });

  it('comes with the conversation list in one response, with members’ markers', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const one = await direct(jonas, maya);
    const two = await direct(priya, maya);
    await send(jonas, one);
    const latest = await send(priya, two);
    await send(priya, two);
    await read(priya, two, latest.createdAt);

    const list = conversationListSchema.parse((await maya.get('/api/conversations')).body).conversations;
    expect(Object.fromEntries(list.map((c) => [c.id, c.unreadCount]))).toEqual({ [one]: 1, [two]: 2 });
    const priyaMember = list.find((c) => c.id === two)!.members.find((m) => m.userId === priya.id)!;
    expect(priyaMember.lastReadAt).not.toBeNull();
  });

  it('stops counting at 100', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    for (let i = 0; i < 105; i++) {
      await t.client.query("insert into messages (conversation_id, sender_id, content) values ($1, $2, 'x')", [id, maya.id]);
    }
    expect(await unreadOf(jonas, id)).toBe(100);
  });
});

describe('POST /api/users/me/seen', () => {
  async function lastSeen(userId: string) {
    const { rows } = await t.client.query<{ last_seen_at: Date | null }>('select last_seen_at from profiles where id = $1', [userId]);
    return rows[0]!.last_seen_at;
  }

  it('records when the user was last active, at most once a minute', async () => {
    const maya = await user();
    expect(await lastSeen(maya.id)).toBeNull();

    expect((await maya.post('/api/users/me/seen')).status).toBe(204);
    const first = await lastSeen(maya.id);
    expect(first).not.toBeNull();

    await maya.post('/api/users/me/seen');
    expect((await lastSeen(maya.id))?.getTime()).toBe(first!.getTime());

    // A minute later it may move again.
    await t.client.query("update profiles set last_seen_at = now() - interval '2 minutes' where id = $1", [maya.id]);
    await maya.post('/api/users/me/seen');
    expect((await lastSeen(maya.id))!.getTime()).toBeGreaterThan(first!.getTime() - 120_000 + 1000);
  });

  it('is visible to fellow members, not in user search', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const id = await direct(maya, jonas);
    await jonas.post('/api/users/me/seen');

    const conversation = conversationSchema.parse((await maya.get(`/api/conversations/${id}`)).body);
    expect(conversation.members.find((m) => m.userId === jonas.id)?.lastSeenAt).not.toBeNull();
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/users/me/seen')).status).toBe(401);
  });
});
