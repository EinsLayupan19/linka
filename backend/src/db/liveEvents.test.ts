import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONVERSATION_ACTIVITY_EVENT,
  CONVERSATION_CHANGED_EVENT,
  CONVERSATION_READ_EVENT,
  CONVERSATION_UPDATED_EVENT,
  conversationActivityEventSchema,
  conversationChangedEventSchema,
  conversationReadEventSchema,
  conversationTopic,
  liveTopic,
  RECEIPT_UPDATED_EVENT,
  receiptUpdatedEventSchema,
  userTopic,
} from '@linka/shared';
import { createConversationStore } from '../services/conversations.js';
import { createMarkerStore } from '../services/markers.js';
import { createMessageStore } from '../services/messages.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// Phase 5 realtime on an in-memory Postgres: which events the database publishes, on which
// private topic, with which payload, and who may join or publish on each topic.

let t: TestDatabase;
let conversations: ReturnType<typeof createConversationStore>;
let messagesStore: ReturnType<typeof createMessageStore>;
let markers: ReturnType<typeof createMarkerStore>;

beforeAll(async () => {
  t = await createTestDatabase();
  conversations = createConversationStore(t.db);
  messagesStore = createMessageStore(t.db);
  markers = createMarkerStore(t.db);
});

afterAll(async () => {
  await t.close();
});

async function pair() {
  const [a, b] = [await t.createUser(), await t.createUser()];
  const { conversation } = await conversations.create(a, { type: 'direct', userId: b });
  return { a, b, id: conversation.id };
}

const send = (from: string, conversationId: string, content = 'hi') =>
  messagesStore.create(from, conversationId, { content, clientId: randomUUID() }).then((r) => r.message);

describe('conversation.activity on user channels (live chat list)', () => {
  it('reaches every member, including the sender’s other tabs, with only the list’s data', async () => {
    const { a, b, id } = await pair();
    const message = await send(a, id, 'New in the list');

    for (const member of [a, b]) {
      const events = await t.broadcastsOn(userTopic(member), CONVERSATION_ACTIVITY_EVENT);
      expect(events).toHaveLength(1);
      expect(events[0]!.private).toBe(true);
      expect(conversationActivityEventSchema.parse(events[0]!.payload)).toEqual({ conversationId: id, lastMessage: message });
    }
  });

  it('never reaches people outside the conversation', async () => {
    const { a, id } = await pair();
    const outsider = await t.createUser();
    await send(a, id);
    expect(await t.broadcastsOn(userTopic(outsider))).toEqual([]);
  });
});

describe('receipts', () => {
  it('publishes receipt.updated on the conversation channel and conversation.read on the reader’s own channel', async () => {
    const { a, b, id } = await pair();
    const message = await send(a, id);

    await markers.markRead(b, id, { lastReadAt: message.createdAt });

    const receipts = await t.broadcastsOn(conversationTopic(id), RECEIPT_UPDATED_EVENT);
    expect(receipts.map((e) => receiptUpdatedEventSchema.parse(e.payload))).toEqual([
      { conversationId: id, userId: b, lastDeliveredAt: message.createdAt, lastReadAt: message.createdAt },
    ]);
    const reads = await t.broadcastsOn(userTopic(b), CONVERSATION_READ_EVENT);
    expect(reads.map((e) => conversationReadEventSchema.parse(e.payload))).toEqual([
      { conversationId: id, lastReadAt: message.createdAt },
    ]);
    expect(await t.broadcastsOn(userTopic(a), CONVERSATION_READ_EVENT)).toEqual([]);
  });

  it('publishes nothing when a marker does not actually move', async () => {
    const { a, b, id } = await pair();
    const message = await send(a, id);
    await markers.markRead(b, id, { lastReadAt: message.createdAt });
    await markers.markRead(b, id, { lastReadAt: message.createdAt });
    await markers.markDelivered(b, { conversations: [{ conversationId: id, lastDeliveredAt: message.createdAt }] });

    expect(await t.broadcastsOn(conversationTopic(id), RECEIPT_UPDATED_EVENT)).toHaveLength(1);
  });

  it('publishes delivery-only changes without a read event', async () => {
    const { a, b, id } = await pair();
    const message = await send(a, id);
    await markers.markDelivered(b, { conversations: [{ conversationId: id, lastDeliveredAt: message.createdAt }] });

    const receipts = await t.broadcastsOn(conversationTopic(id), RECEIPT_UPDATED_EVENT);
    expect(receiptUpdatedEventSchema.parse(receipts[0]!.payload)).toMatchObject({ lastDeliveredAt: message.createdAt, lastReadAt: null });
    expect(await t.broadcastsOn(userTopic(b), CONVERSATION_READ_EVENT)).toEqual([]);
  });
});

describe('membership changes', () => {
  it('tells each new member, once per member, and the conversation once per statement', async () => {
    const [owner, x, y] = [await t.createUser(), await t.createUser(), await t.createUser()];
    const { conversation } = await conversations.create(owner, { type: 'group', name: 'Team', memberIds: [x, y] });

    for (const member of [owner, x, y]) {
      const changes = await t.broadcastsOn(userTopic(member), CONVERSATION_CHANGED_EVENT);
      expect(changes.map((e) => conversationChangedEventSchema.parse(e.payload))).toEqual([
        { conversationId: conversation.id, change: 'added' },
      ]);
    }
    expect(await t.broadcastsOn(conversationTopic(conversation.id), CONVERSATION_UPDATED_EVENT)).toHaveLength(1);
  });

  it('tells a removed member, and anyone viewing', async () => {
    const [owner, x] = [await t.createUser(), await t.createUser()];
    const { conversation } = await conversations.create(owner, { type: 'group', name: 'Team', memberIds: [x] });
    await conversations.removeMember(owner, conversation.id, x);

    const changes = (await t.broadcastsOn(userTopic(x), CONVERSATION_CHANGED_EVENT)).map((e) => e.payload);
    expect(changes).toContainEqual({ conversationId: conversation.id, change: 'removed' });
    expect(await t.broadcastsOn(conversationTopic(conversation.id), CONVERSATION_UPDATED_EVENT)).toHaveLength(2);
  });

  it('announces role changes and renames', async () => {
    const [owner, x] = [await t.createUser(), await t.createUser()];
    const { conversation } = await conversations.create(owner, { type: 'group', name: 'Team', memberIds: [x] });
    await conversations.updateMemberRole(owner, conversation.id, x, 'admin');
    await conversations.rename(owner, conversation.id, { name: 'Renamed' });

    expect(await t.broadcastsOn(conversationTopic(conversation.id), CONVERSATION_UPDATED_EVENT)).toHaveLength(3);
    const changes = (await t.broadcastsOn(userTopic(x), CONVERSATION_CHANGED_EVENT)).map((e) => e.payload);
    expect(changes).toContainEqual({ conversationId: conversation.id, change: 'updated' });
  });

  it('a message bumping the conversation’s activity is not announced as an update', async () => {
    const { a, id } = await pair();
    const before = (await t.broadcastsOn(conversationTopic(id), CONVERSATION_UPDATED_EVENT)).length;
    await send(a, id);
    expect(await t.broadcastsOn(conversationTopic(id), CONVERSATION_UPDATED_EVENT)).toHaveLength(before);
  });
});

describe('realtime failures never block writes', () => {
  it('still stores messages, markers, memberships and renames when realtime.send fails', async () => {
    const isolated = await createTestDatabase();
    try {
      const [owner, x] = [await isolated.createUser(), await isolated.createUser()];
      await isolated.client.exec(`
        create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
        returns void language plpgsql as $$ begin raise exception 'realtime is down'; end; $$;
      `);
      const store = createConversationStore(isolated.db);
      const { conversation } = await store.create(owner, { type: 'group', name: 'Team', memberIds: [x] });
      const { message } = await createMessageStore(isolated.db).create(x, conversation.id, { content: 'hi', clientId: randomUUID() });
      await createMarkerStore(isolated.db).markRead(owner, conversation.id, { lastReadAt: message.createdAt });
      await store.updateMemberRole(owner, conversation.id, x, 'admin');
      await store.rename(owner, conversation.id, { name: 'Still works' });
      await store.removeMember(owner, conversation.id, x);

      expect((await store.getForUser(owner, conversation.id)).name).toBe('Still works');
    } finally {
      await isolated.close();
    }
  });
});

describe('who may join and publish', () => {
  it('user:<id>: only that user may join, nobody may publish', async () => {
    const [maya, jonas] = [await t.createUser(), await t.createUser()];
    expect(await t.canJoinTopic('authenticated', maya, userTopic(maya))).toBe(true);
    expect(await t.canJoinTopic('authenticated', jonas, userTopic(maya))).toBe(false);
    expect(await t.canJoinTopic('anon', null, userTopic(maya))).toBe(false);
    expect(await t.canPublishOnTopic('authenticated', maya, userTopic(maya))).toBe(false);
  });

  it('user:<id>: no prefix, wildcard or case trick admits another user', async () => {
    const maya = await t.createUser();
    for (const topic of ['user:', 'user:*', `user:${maya}x`, `USER:${maya}`, `user:${maya.toUpperCase()}`, `user: ${maya}`]) {
      expect(await t.canJoinTopic('authenticated', maya, topic), topic).toBe(false);
    }
  });

  it('live:<id>: members may receive and publish typing and presence; outsiders neither', async () => {
    const { a, id } = await pair();
    const outsider = await t.createUser();
    for (const extension of ['broadcast', 'presence'] as const) {
      expect(await t.canJoinTopic('authenticated', a, liveTopic(id), extension), extension).toBe(true);
      expect(await t.canPublishOnTopic('authenticated', a, liveTopic(id), extension), extension).toBe(true);
      expect(await t.canJoinTopic('authenticated', outsider, liveTopic(id), extension), extension).toBe(false);
      expect(await t.canPublishOnTopic('authenticated', outsider, liveTopic(id), extension), extension).toBe(false);
    }
    expect(await t.canJoinTopic('anon', null, liveTopic(id), 'presence')).toBe(false);
  });

  it('live:<id>: malformed topics are denied', async () => {
    const { a } = await pair();
    for (const topic of ['live:', 'live:not-a-uuid', `live:${randomUUID()}`]) {
      expect(await t.canPublishOnTopic('authenticated', a, topic), topic).toBe(false);
    }
  });

  it('conversation:<id> stays database-only: members still cannot publish, nor use presence there', async () => {
    const { a, id } = await pair();
    expect(await t.canJoinTopic('authenticated', a, conversationTopic(id))).toBe(true);
    expect(await t.canPublishOnTopic('authenticated', a, conversationTopic(id))).toBe(false);
    expect(await t.canJoinTopic('authenticated', a, conversationTopic(id), 'presence')).toBe(false);
  });

  it('a member who leaves loses the live channel', async () => {
    const [owner, x] = [await t.createUser(), await t.createUser()];
    const { conversation } = await conversations.create(owner, { type: 'group', name: 'Team', memberIds: [x] });
    await conversations.removeMember(x, conversation.id, x);
    expect(await t.canJoinTopic('authenticated', x, liveTopic(conversation.id), 'presence')).toBe(false);
  });
});
