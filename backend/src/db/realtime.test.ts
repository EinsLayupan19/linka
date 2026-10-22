import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationTopic, MESSAGE_CREATED_EVENT, messageSchema } from '@linka/shared';
import { createConversationStore } from '../services/conversations.js';
import { createMessageStore } from '../services/messages.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// Realtime delivery (Broadcast from Database) against an in-memory Postgres with a stand-in for
// Supabase's realtime schema. What Supabase does after realtime.send() (WebSocket delivery) is
// not simulated; what is tested is what we control: the trigger, the payload, and who may join.

let t: TestDatabase;
let maya: string;
let jonas: string;
let outsider: string;
let conversationId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  [maya, jonas, outsider] = [await t.createUser('maya'), await t.createUser('jonas'), await t.createUser('outsider')];
  const { conversation } = await createConversationStore(t.db).create(maya, { type: 'direct', userId: jonas });
  conversationId = conversation.id;
});

afterAll(async () => {
  await t.close();
});

describe('message.created broadcast', () => {
  it('publishes each new message once, privately, on its conversation’s topic', async () => {
    const { message } = await createMessageStore(t.db).create(maya, conversationId, {
      content: 'Realtime hello',
      clientId: randomUUID(),
    });

    const events = await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: MESSAGE_CREATED_EVENT, private: true });
    // The payload is exactly the API's Message, so the client handles both the same way.
    expect(messageSchema.parse(events[0]!.payload)).toEqual(message);
  });

  it('includes only Message fields', async () => {
    const events = await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT);
    expect(Object.keys(events[0]!.payload as object).sort()).toEqual(
      ['clientId', 'content', 'conversationId', 'createdAt', 'deletedAt', 'editedAt', 'id', 'senderId', 'type'].sort(),
    );
  });

  it('does not broadcast a retried message a second time', async () => {
    const store = createMessageStore(t.db);
    const clientId = randomUUID();
    const before = (await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT)).length;

    await store.create(maya, conversationId, { content: 'Retry me', clientId });
    await store.create(maya, conversationId, { content: 'Retry me', clientId });

    expect(await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT)).toHaveLength(before + 1);
  });

  it('does not broadcast a message whose transaction rolled back', async () => {
    const before = (await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT)).length;
    await t.client.transaction(async (tx) => {
      await tx.query("insert into messages (conversation_id, sender_id, content) values ($1, $2, 'never stored')", [
        conversationId,
        maya,
      ]);
      await tx.rollback();
    });
    expect(await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT)).toHaveLength(before);
  });

  it('never publishes on another conversation’s topic', async () => {
    const { conversation: other } = await createConversationStore(t.db).create(outsider, {
      type: 'direct',
      userId: jonas,
    });
    await createMessageStore(t.db).create(outsider, other.id, { content: 'Elsewhere', clientId: randomUUID() });

    const ours = await t.broadcastsOn(conversationTopic(conversationId), MESSAGE_CREATED_EVENT);
    expect(ours.some((e) => (e.payload as { content: string }).content === 'Elsewhere')).toBe(false);
  });
});

describe('a broadcast failure never blocks sending', () => {
  it('stores the message even when realtime.send fails', async () => {
    const isolated = await createTestDatabase();
    try {
      const [a, b] = [await isolated.createUser(), await isolated.createUser()];
      const { conversation } = await createConversationStore(isolated.db).create(a, { type: 'direct', userId: b });
      await isolated.client.exec(`
        create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
        returns void language plpgsql as $$ begin raise exception 'realtime is down'; end; $$;
      `);

      const { message, created } = await createMessageStore(isolated.db).create(a, conversation.id, {
        content: 'Still saved',
        clientId: randomUUID(),
      });

      expect(created).toBe(true);
      const { rows } = await isolated.client.query('select content from messages where id = $1', [message.id]);
      expect(rows).toEqual([{ content: 'Still saved' }]);
    } finally {
      await isolated.close();
    }
  });
});

describe('who may join conversation:<id>', () => {
  it('lets members join their conversation’s channel', async () => {
    expect(await t.canJoinTopic('authenticated', maya, conversationTopic(conversationId))).toBe(true);
    expect(await t.canJoinTopic('authenticated', jonas, conversationTopic(conversationId))).toBe(true);
  });

  it('refuses signed-in users who are not members', async () => {
    expect(await t.canJoinTopic('authenticated', outsider, conversationTopic(conversationId))).toBe(false);
  });

  it('refuses anonymous clients', async () => {
    expect(await t.canJoinTopic('anon', null, conversationTopic(conversationId))).toBe(false);
  });

  it('refuses malformed and unknown topics without erroring', async () => {
    for (const topic of ['conversation:not-a-uuid', 'conversation:', 'everything', `room:${conversationId}`, `conversation:${randomUUID()}`]) {
      expect(await t.canJoinTopic('authenticated', maya, topic), topic).toBe(false);
    }
  });

  it('stops admitting someone once they leave a group', async () => {
    const store = createConversationStore(t.db);
    const { conversation } = await store.create(maya, { type: 'group', name: 'Leavers', memberIds: [outsider] });
    expect(await t.canJoinTopic('authenticated', outsider, conversationTopic(conversation.id))).toBe(true);

    await store.removeMember(outsider, conversation.id, outsider);
    expect(await t.canJoinTopic('authenticated', outsider, conversationTopic(conversation.id))).toBe(false);
  });

  it('does not let browser clients publish broadcasts (no INSERT policy)', async () => {
    await expect(
      t.asRole('authenticated', maya, (tx) =>
        tx.query("insert into realtime.messages (topic, extension, event, payload, private) values ($1, 'broadcast', 'message.created', '{}', true)", [
          conversationTopic(conversationId),
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
