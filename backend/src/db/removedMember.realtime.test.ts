import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONVERSATION_UPDATED_EVENT,
  conversationSchema,
  conversationTopic,
  liveTopic,
  MESSAGE_CREATED_EVENT,
  RECEIPT_UPDATED_EVENT,
} from '@linka/shared';
import { createConversationStore } from '../services/conversations.js';
import { createMarkerStore } from '../services/markers.js';
import { createMessageStore } from '../services/messages.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// Someone removed from a group must stop receiving it live. Supabase checks private channels when
// they are joined, not per event, so a removed member's open channel would keep receiving. Removing
// anyone therefore moves the group to new topics (channel version + 1): the database publishes only
// there, and joining them needs current membership. What Supabase does with the old, now silent,
// channel is not simulated: what is tested is where events go and who may join (migration 0013).

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

async function groupWithThree() {
  const [owner, stays, leaves] = [await t.createUser(), await t.createUser(), await t.createUser()];
  const conversations = createConversationStore(t.db);
  const { conversation } = await conversations.create(owner, { type: 'group', name: 'Trip', memberIds: [stays, leaves] });
  return { id: conversation.id, owner, stays, leaves, conversations, messages: createMessageStore(t.db) };
}

const send = (messages: ReturnType<typeof createMessageStore>, from: string, id: string, content: string) =>
  messages.create(from, id, { content, clientId: randomUUID() });

describe('a member removed from a group', () => {
  it('moves the group to new topics: the API reports channel version 1 to the remaining members', async () => {
    const { id, owner, leaves, conversations } = await groupWithThree();
    expect((await conversations.getForUser(owner, id)).channelVersion).toBe(0);

    await conversations.removeMember(owner, id, leaves);

    expect(conversationSchema.parse(await conversations.getForUser(owner, id)).channelVersion).toBe(1);
  });

  it('tells whoever is still on the old channel to refetch, then publishes nothing more there', async () => {
    const { id, owner, leaves, conversations, messages } = await groupWithThree();
    const oldTopic = conversationTopic(id, 0);
    const before = (await t.broadcastsOn(oldTopic)).length;

    await conversations.removeMember(owner, id, leaves);
    // The removal is announced on the old topic (that is where everyone, including the removed
    // member, still listens), so the remaining members refetch and move to version 1.
    const announced = await t.broadcastsOn(oldTopic);
    expect(announced.slice(before).map((e) => e.event)).toEqual([CONVERSATION_UPDATED_EVENT]);

    const { message } = await send(messages, owner, id, 'After you left');
    await createMarkerStore(t.db).markRead(owner, id, { lastReadAt: message.createdAt });

    // Nothing new on the topic the removed member had joined...
    expect(await t.broadcastsOn(oldTopic)).toHaveLength(announced.length);
    // ...and the new message and receipt went to version 1 only.
    const fresh = await t.broadcastsOn(conversationTopic(id, 1));
    expect(fresh.map((e) => e.event)).toEqual([MESSAGE_CREATED_EVENT, RECEIPT_UPDATED_EVENT]);
    expect(fresh[0]!.payload).toMatchObject({ content: 'After you left' });
  });

  it('cannot join the new topics, or rejoin the old ones; the remaining members join the new ones', async () => {
    const { id, owner, stays, leaves, conversations } = await groupWithThree();
    await conversations.removeMember(owner, id, leaves);

    for (const topic of [conversationTopic(id, 1), conversationTopic(id, 0)]) {
      expect(await t.canJoinTopic('authenticated', leaves, topic)).toBe(false);
    }
    for (const topic of [liveTopic(id, 1), liveTopic(id, 0)]) {
      expect(await t.canJoinTopic('authenticated', leaves, topic)).toBe(false);
      expect(await t.canJoinTopic('authenticated', leaves, topic, 'presence')).toBe(false);
      expect(await t.canPublishOnTopic('authenticated', leaves, topic)).toBe(false);
    }

    expect(await t.canJoinTopic('authenticated', stays, conversationTopic(id, 1))).toBe(true);
    expect(await t.canJoinTopic('authenticated', stays, liveTopic(id, 1), 'presence')).toBe(true);
    expect(await t.canPublishOnTopic('authenticated', stays, liveTopic(id, 1))).toBe(true);
    // An out-of-date topic is refused to everyone, so nobody stays behind on a silent channel.
    expect(await t.canJoinTopic('authenticated', stays, conversationTopic(id, 0))).toBe(false);
  });

  it('also applies when someone leaves on their own, and every removal moves the version on', async () => {
    const { id, owner, stays, leaves, conversations } = await groupWithThree();
    await conversations.removeMember(leaves, id, leaves);
    await conversations.removeMember(owner, id, stays);
    expect((await conversations.getForUser(owner, id)).channelVersion).toBe(2);
  });

  it('adding people or renaming keeps the version: nobody lost access', async () => {
    const { id, owner, conversations } = await groupWithThree();
    const extra = await t.createUser();
    await conversations.addMembers(owner, id, { userIds: [extra] });
    await conversations.rename(owner, id, { name: 'Lake' });
    expect((await conversations.getForUser(owner, id)).channelVersion).toBe(0);
    expect(await t.canJoinTopic('authenticated', extra, conversationTopic(id, 0))).toBe(true);
  });

  it('a removed member who is added again joins the current topics like anyone else', async () => {
    const { id, owner, leaves, conversations } = await groupWithThree();
    await conversations.removeMember(owner, id, leaves);
    await conversations.addMembers(owner, id, { userIds: [leaves] });
    expect(await t.canJoinTopic('authenticated', leaves, conversationTopic(id, 1))).toBe(true);
  });

  it('refuses malformed versions and topics without a version', async () => {
    const { id, stays } = await groupWithThree();
    for (const topic of [`conversation:${id}`, `conversation:${id}:`, `conversation:${id}:-1`, `conversation:${id}:1x`, `live:${id}`, `live:${id}:01x`]) {
      expect(await t.canJoinTopic('authenticated', stays, topic)).toBe(false);
    }
  });
});
