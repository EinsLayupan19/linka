import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_UPDATED_EVENT, callTopic, callUpdatedEventSchema, userTopic } from '@linka/shared';
import { createCallStore, type CallStore } from '../services/calls.js';
import { createConversationStore } from '../services/conversations.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// Phase 7 at the database level: who may join and publish on a call's signaling channel, and the
// call.updated events published to each participant. Supabase's WebSocket delivery itself is not
// simulated (see db/realtime.test.ts); what is tested is the policy and the trigger.

let t: TestDatabase;
let calls: CallStore;

beforeAll(async () => {
  t = await createTestDatabase();
  calls = createCallStore(t.db);
});

afterAll(async () => {
  await t.close();
});

async function pair() {
  const [maya, jonas] = [await t.createUser(), await t.createUser()];
  const { conversation } = await createConversationStore(t.db).create(maya, { type: 'direct', userId: jonas });
  return { maya, jonas, conversationId: conversation.id };
}

describe('call:<callId> signaling channel', () => {
  it('lets both participants join and publish while the call rings or is active', async () => {
    const { maya, jonas, conversationId } = await pair();
    const call = await calls.start(maya, conversationId, 'voice');
    const topic = callTopic(call.id);

    for (const user of [maya, jonas]) {
      expect(await t.canJoinTopic('authenticated', user, topic)).toBe(true);
      expect(await t.canPublishOnTopic('authenticated', user, topic)).toBe(true);
    }
    await calls.accept(jonas, call.id);
    expect(await t.canPublishOnTopic('authenticated', jonas, topic)).toBe(true);
  });

  it('keeps everyone else out: other users, other calls, anonymous, malformed topics', async () => {
    const { maya, jonas, conversationId } = await pair();
    const other = await pair();
    const outsider = await t.createUser();
    const call = await calls.start(maya, conversationId, 'voice');
    const otherCall = await calls.start(other.maya, other.conversationId, 'voice');
    const topic = callTopic(call.id);

    expect(await t.canJoinTopic('authenticated', outsider, topic)).toBe(false);
    expect(await t.canPublishOnTopic('authenticated', outsider, topic)).toBe(false);
    expect(await t.canJoinTopic('authenticated', maya, callTopic(otherCall.id))).toBe(false);
    expect(await t.canPublishOnTopic('authenticated', jonas, callTopic(otherCall.id))).toBe(false);
    expect(await t.canJoinTopic('anon', null, topic)).toBe(false);
    expect(await t.canJoinTopic('authenticated', maya, callTopic(randomUUID()))).toBe(false);
    for (const malformed of [`call:${call.id.toUpperCase()}`, `call:${call.id}x`, `call:`, `xcall:${call.id}`]) {
      expect(await t.canJoinTopic('authenticated', maya, malformed)).toBe(false);
    }
  });

  it('closes once the call is over', async () => {
    const { maya, jonas, conversationId } = await pair();
    const call = await calls.start(maya, conversationId, 'voice');
    await calls.accept(jonas, call.id);
    await calls.end(maya, call.id);

    expect(await t.canJoinTopic('authenticated', maya, callTopic(call.id))).toBe(false);
    expect(await t.canPublishOnTopic('authenticated', jonas, callTopic(call.id))).toBe(false);
  });

  it('allows broadcast only (no presence on call channels)', async () => {
    const { maya, conversationId } = await pair();
    const call = await calls.start(maya, conversationId, 'voice');
    expect(await t.canPublishOnTopic('authenticated', maya, callTopic(call.id), 'presence')).toBe(false);
    expect(await t.canJoinTopic('authenticated', maya, callTopic(call.id), 'presence')).toBe(false);
  });

  it('does not let a participant publish server events on their user channel', async () => {
    const { maya, conversationId } = await pair();
    await calls.start(maya, conversationId, 'voice');
    expect(await t.canPublishOnTopic('authenticated', maya, userTopic(maya))).toBe(false);
  });
});

describe('call.updated', () => {
  it('reaches both participants on every state change, with exactly the API’s Call', async () => {
    const { maya, jonas, conversationId } = await pair();
    const outsider = await t.createUser();

    const started = await calls.start(maya, conversationId, 'voice');
    for (const user of [maya, jonas]) {
      const events = await t.broadcastsOn(userTopic(user), CALL_UPDATED_EVENT);
      expect(events).toHaveLength(1);
      expect(events[0]!.private).toBe(true);
      expect(callUpdatedEventSchema.parse(events[0]!.payload)).toEqual(started);
    }

    const accepted = await calls.accept(jonas, started.id);
    const ended = await calls.end(jonas, started.id);
    const payloads = (await t.broadcastsOn(userTopic(maya), CALL_UPDATED_EVENT)).map((e) => callUpdatedEventSchema.parse(e.payload));
    expect(payloads.map((p) => p.status)).toEqual(['ringing', 'active', 'ended']);
    expect(payloads[1]).toEqual(accepted);
    expect(payloads[2]).toEqual(ended);
    expect(await t.broadcastsOn(userTopic(outsider))).toEqual([]);
  });

  it('is not published for heartbeats, repeated transitions or rolled-back changes', async () => {
    const { maya, jonas, conversationId } = await pair();
    const call = await calls.start(maya, conversationId, 'voice');
    await calls.accept(jonas, call.id);
    const count = async () => (await t.broadcastsOn(userTopic(jonas), CALL_UPDATED_EVENT)).length;
    const before = await count();

    await calls.heartbeat(maya, call.id);
    await calls.accept(jonas, call.id); // retry
    await t.client.query('update calls set status = status where id = $1', [call.id]); // touches status, changes nothing
    await t.client.transaction(async (tx) => {
      await tx.query(`update calls set status = 'ended', ended_at = now() where id = $1`, [call.id]);
      await tx.rollback();
    });

    expect(await count()).toBe(before);
  });

  it('is published when the server expires a call', async () => {
    const { maya, jonas, conversationId } = await pair();
    const call = await calls.start(maya, conversationId, 'voice');
    await t.client.query(`update calls set created_at = now() - interval '2 minutes' where id = $1`, [call.id]);

    await calls.expireStale();

    const last = (await t.broadcastsOn(userTopic(jonas), CALL_UPDATED_EVENT)).at(-1)!;
    expect(callUpdatedEventSchema.parse(last.payload)).toMatchObject({ id: call.id, status: 'missed' });
  });
});
