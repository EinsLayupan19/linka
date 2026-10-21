import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callSchema, messageSchema } from '@linka/shared';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { AppError } from '../utils/AppError.js';
import { createCallStore, type CallStore } from './calls.js';
import { createConversationStore, type ConversationStore } from './conversations.js';
import { createMessageStore, type MessageStore } from './messages.js';

let t: TestDatabase;
let conversations: ConversationStore;
let messageStore: MessageStore;
let callStore: CallStore;

beforeAll(async () => {
  t = await createTestDatabase();
  conversations = createConversationStore(t.db);
  messageStore = createMessageStore(t.db);
  callStore = createCallStore(t.db);
});

afterAll(async () => {
  await t.close();
});

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode: status, code });
}

async function groupWith(...memberIds: string[]) {
  const [owner, ...others] = memberIds;
  const { conversation } = await conversations.create(owner!, { type: 'group', name: 'Group', memberIds: others });
  return conversation.id;
}

describe('messages', () => {
  it('stores a member’s message with them as sender, in the right conversation', async () => {
    const [maya, jonas] = [await t.createUser(), await t.createUser()];
    const conversationId = await groupWith(maya, jonas);

    const message = messageSchema.parse(await messageStore.create(jonas, conversationId, { content: 'Hello' }));

    expect(message).toMatchObject({ conversationId, senderId: jonas, type: 'text', content: 'Hello', editedAt: null });
    const { rows } = await t.client.query('select conversation_id, sender_id from messages where id = $1', [message.id]);
    expect(rows).toEqual([{ conversation_id: conversationId, sender_id: jonas }]);
  });

  it('refuses messages from non-members with a 404', async () => {
    const [maya, jonas, outsider] = [await t.createUser(), await t.createUser(), await t.createUser()];
    const conversationId = await groupWith(maya, jonas);

    await expectAppError(messageStore.create(outsider, conversationId, { content: 'Let me in' }), 404, 'CONVERSATION_NOT_FOUND');
    const { rows } = await t.client.query('select 1 from messages where conversation_id = $1', [conversationId]);
    expect(rows).toEqual([]);
  });

  it('refuses messages to a conversation that does not exist', async () => {
    await expectAppError(messageStore.create(await t.createUser(), randomUUID(), { content: 'Hi' }), 404, 'CONVERSATION_NOT_FOUND');
  });

  it('refuses messages from someone who has left', async () => {
    const [maya, jonas] = [await t.createUser(), await t.createUser()];
    const conversationId = await groupWith(maya, jonas);
    await conversations.removeMember(jonas, conversationId, jonas);

    await expectAppError(messageStore.create(jonas, conversationId, { content: 'Still here?' }), 404, 'CONVERSATION_NOT_FOUND');
  });
});

describe('calls', () => {
  it('lets a member start a call that includes exactly the conversation’s members', async () => {
    const [maya, jonas] = [await t.createUser(), await t.createUser()];
    const outsider = await t.createUser();
    const conversationId = await groupWith(maya, jonas);

    const call = callSchema.parse(await callStore.start(maya, conversationId, 'video'));

    expect(call).toMatchObject({ conversationId, initiatorId: maya, type: 'video', status: 'ringing' });
    expect(call.participants.map((p) => p.userId).sort()).toEqual([maya, jonas].sort());
    expect(call.participants.find((p) => p.userId === maya)?.joinedAt).not.toBeNull();
    expect(call.participants.find((p) => p.userId === jonas)?.joinedAt).toBeNull();
    expect(call.participants.some((p) => p.userId === outsider)).toBe(false);
  });

  it('refuses to let non-members start a call', async () => {
    const [maya, jonas, outsider] = [await t.createUser(), await t.createUser(), await t.createUser()];
    const conversationId = await groupWith(maya, jonas);

    await expectAppError(callStore.start(outsider, conversationId, 'voice'), 404, 'CONVERSATION_NOT_FOUND');
  });

  it('allows only one ongoing call per conversation', async () => {
    const [maya, jonas] = [await t.createUser(), await t.createUser()];
    const conversationId = await groupWith(maya, jonas);
    await callStore.start(maya, conversationId, 'voice');

    await expectAppError(callStore.start(jonas, conversationId, 'voice'), 409, 'CALL_IN_PROGRESS');
  });

  it('shows a call to members and hides it from everyone else', async () => {
    const [maya, jonas, outsider] = [await t.createUser(), await t.createUser(), await t.createUser()];
    const conversationId = await groupWith(maya, jonas);
    const call = await callStore.start(maya, conversationId, 'voice');

    expect((await callStore.getForUser(jonas, call.id)).id).toBe(call.id);
    await expectAppError(callStore.getForUser(outsider, call.id), 404, 'NOT_FOUND');
    await expectAppError(callStore.getForUser(outsider, randomUUID()), 404, 'NOT_FOUND');
  });

  it('rejects an invalid call type at the database', async () => {
    const [maya, jonas] = [await t.createUser(), await t.createUser()];
    const conversationId = await groupWith(maya, jonas);

    // @ts-expect-error: deliberately invalid
    await expect(callStore.start(maya, conversationId, 'hologram')).rejects.toThrow();
  });
});
