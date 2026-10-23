import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_RING_EXPIRY_SECONDS, CALL_STALE_SECONDS, callListSchema, callSchema, iceServersResponseSchema } from '@linka/shared';
import { createApp } from '../app.js';
import { createCallStore } from '../services/calls.js';
import { createConversationStore } from '../services/conversations.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

let t: TestDatabase;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let app: ReturnType<typeof createApp>;
const iceServers = [{ urls: 'stun:stun.test:3478' }];

beforeAll(async () => {
  t = await createTestDatabase();
  auth = await createTestAuth();
  app = createApp({
    verifyAccessToken: auth.verifyAccessToken,
    conversations: createConversationStore(t.db),
    calls: createCallStore(t.db),
    iceServers,
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
  };
}
type User = Awaited<ReturnType<typeof user>>;

async function direct(a: User, b: User): Promise<string> {
  return (await a.post('/api/conversations', { type: 'direct', userId: b.id })).body.id as string;
}

/** Maya calls Jonas in their 1:1 conversation. */
async function ringing() {
  const [maya, jonas] = await Promise.all([user(), user()]);
  const conversationId = await direct(maya, jonas);
  const res = await maya.post('/api/calls', { conversationId, type: 'voice' });
  expect(res.status).toBe(201);
  return { maya, jonas, conversationId, callId: res.body.id as string };
}

const status = async (callId: string) =>
  (await t.client.query<{ status: string }>('select status from calls where id = $1', [callId])).rows[0]!.status;

describe('starting a call', () => {
  it('rings the other member: the caller has joined, the callee not yet', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);

    const res = await maya.post('/api/calls', { conversationId, type: 'voice' });

    expect(res.status).toBe(201);
    const call = callSchema.parse(res.body);
    expect(call).toMatchObject({ conversationId, initiatorId: maya.id, type: 'voice', status: 'ringing', startedAt: null, endedAt: null });
    expect(call.participants.find((p) => p.userId === maya.id)?.joinedAt).not.toBeNull();
    expect(call.participants.find((p) => p.userId === jonas.id)?.joinedAt).toBeNull();
    expect(Object.keys(res.body).sort()).toEqual(['conversationId', 'createdAt', 'endedAt', 'id', 'initiatorId', 'participants', 'startedAt', 'status', 'type']);
  });

  it('requires authentication and membership', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const conversationId = await direct(maya, jonas);

    expect((await request(app).post('/api/calls').send({ conversationId, type: 'voice' })).status).toBe(401);
    const res = await outsider.post('/api/calls', { conversationId, type: 'voice' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('refuses group calls', async () => {
    const [owner, member] = await Promise.all([user(), user()]);
    const group = (await owner.post('/api/conversations', { type: 'group', name: 'G', memberIds: [member.id] })).body.id as string;
    const res = await owner.post('/api/calls', { conversationId: group, type: 'voice' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CALL_NOT_SUPPORTED');
  });

  it.each([
    ['a video call (Phase 8)', { type: 'video' }],
    ['a missing type', { type: undefined }],
    ['a malformed conversation id', { conversationId: 'abc' }],
    ['a spoofed initiator', { initiatorId: randomUUID() }],
    ['a client-chosen status', { status: 'active' }],
  ])('rejects %s', async (_label, overrides) => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversationId = await direct(maya, jonas);
    const res = await maya.post('/api/calls', { conversationId, type: 'voice', ...overrides });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('when both call each other at once, the second learns a call is already in progress', async () => {
    const { jonas, conversationId } = await ringing();
    const res = await jonas.post('/api/calls', { conversationId, type: 'voice' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CALL_IN_PROGRESS');
  });

  it('refuses when the caller or the callee is already in another call', async () => {
    const { maya, jonas } = await ringing();
    const priya = await user();

    const callerBusy = await maya.post('/api/calls', { conversationId: await direct(maya, priya), type: 'voice' });
    expect(callerBusy.status).toBe(409);
    expect(callerBusy.body.error).toEqual({ code: 'USER_BUSY', message: 'You are already in a call.' });

    const calleeBusy = await priya.post('/api/calls', { conversationId: await direct(priya, jonas), type: 'voice' });
    expect(calleeBusy.status).toBe(409);
    expect(calleeBusy.body.error.message).toBe('They are on another call. Try again later.');
  });
});

describe('answering', () => {
  it('the callee accepts: the call becomes active and both have joined', async () => {
    const { maya, jonas, callId } = await ringing();

    const res = await jonas.post(`/api/calls/${callId}/accept`);

    expect(res.status).toBe(200);
    const call = callSchema.parse(res.body);
    expect(call.status).toBe('active');
    expect(call.startedAt).not.toBeNull();
    expect(call.participants.every((p) => p.joinedAt !== null)).toBe(true);
    expect((await maya.get(`/api/calls/${callId}`)).body.status).toBe('active');
  });

  it('accepting again (a retry, or a second tab) changes nothing', async () => {
    const { jonas, callId } = await ringing();
    const first = await jonas.post(`/api/calls/${callId}/accept`);
    const again = await jonas.post(`/api/calls/${callId}/accept`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
  });

  it('only the callee can accept or decline; outsiders cannot see the call at all', async () => {
    const { maya, callId } = await ringing();
    const outsider = await user();

    expect((await maya.post(`/api/calls/${callId}/accept`)).status).toBe(403);
    expect((await maya.post(`/api/calls/${callId}/decline`)).status).toBe(403);
    for (const action of ['accept', 'decline', 'end', 'heartbeat']) {
      const res = await outsider.post(`/api/calls/${callId}/${action}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect((await outsider.get(`/api/calls/${callId}`)).status).toBe(404);
    expect((await outsider.post('/api/calls/not-a-uuid/accept')).status).toBe(404);
    expect(await status(callId)).toBe('ringing');
  });

  it('the callee declines', async () => {
    const { jonas, callId } = await ringing();
    const res = await jonas.post(`/api/calls/${callId}/decline`);
    expect(res.body).toMatchObject({ status: 'declined', endedAt: expect.any(String) });
    expect((await jonas.post(`/api/calls/${callId}/decline`)).status).toBe(200); // retry
    const accept = await jonas.post(`/api/calls/${callId}/accept`);
    expect(accept.status).toBe(409);
    expect(accept.body.error).toEqual({ code: 'CALL_ENDED', message: 'This call was declined.' });
  });

  it('cannot answer a call the caller already cancelled', async () => {
    const { maya, jonas, callId } = await ringing();
    expect((await maya.post(`/api/calls/${callId}/end`)).body.status).toBe('missed');
    const res = await jonas.post(`/api/calls/${callId}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CALL_ENDED');
  });

  it('accept racing the caller cancelling resolves to exactly one outcome', async () => {
    for (let i = 0; i < 3; i++) {
      const { maya, jonas, callId } = await ringing();
      const [accept, cancel] = await Promise.all([jonas.post(`/api/calls/${callId}/accept`), maya.post(`/api/calls/${callId}/end`)]);
      const final = await status(callId);
      if (accept.status === 200) {
        // Answered first, then hung up by the caller's end.
        expect(['active', 'ended']).toContain(final);
        expect(cancel.body.status).toBe(final);
      } else {
        expect(accept.status).toBe(409);
        expect(final).toBe('missed');
      }
    }
  });

  it('two tabs answering at once both succeed with one start time', async () => {
    const { jonas, callId } = await ringing();
    const [a, b] = await Promise.all([jonas.post(`/api/calls/${callId}/accept`), jonas.post(`/api/calls/${callId}/accept`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.startedAt).toBe(b.body.startedAt);
  });
});

describe('ending', () => {
  it('either side hangs up an active call; everyone leaves', async () => {
    const { maya, jonas, callId } = await ringing();
    await jonas.post(`/api/calls/${callId}/accept`);

    const res = await jonas.post(`/api/calls/${callId}/end`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ended');
    expect(res.body.participants.every((p: { leftAt: string | null }) => p.leftAt !== null)).toBe(true);
    expect((await maya.post(`/api/calls/${callId}/end`)).body.status).toBe('ended'); // the other side, too late: fine
  });

  it('the callee hanging up while it rings declines it', async () => {
    const { jonas, callId } = await ringing();
    expect((await jonas.post(`/api/calls/${callId}/end`)).body.status).toBe('declined');
  });

  it('heartbeats keep an active call alive and stop working once it ended', async () => {
    const { maya, jonas, callId } = await ringing();
    await jonas.post(`/api/calls/${callId}/accept`);
    await t.client.query(`update calls set last_heartbeat_at = now() - interval '30 seconds' where id = $1`, [callId]);

    expect((await maya.post(`/api/calls/${callId}/heartbeat`)).status).toBe(204);
    const { rows } = await t.client.query<{ fresh: boolean }>(
      `select last_heartbeat_at > now() - interval '5 seconds' as fresh from calls where id = $1`,
      [callId],
    );
    expect(rows[0]!.fresh).toBe(true);

    await maya.post(`/api/calls/${callId}/end`);
    const res = await jonas.post(`/api/calls/${callId}/heartbeat`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CALL_ENDED');
  });
});

describe('calls nobody is in any more', () => {
  it('an unanswered call becomes missed after the ring timeout, freeing both people', async () => {
    const { maya, jonas, conversationId, callId } = await ringing();
    await t.client.query(`update calls set created_at = now() - make_interval(secs => $2) where id = $1`, [callId, CALL_RING_EXPIRY_SECONDS + 1]);

    expect((await jonas.get('/api/calls/ongoing')).body.calls).toEqual([]);
    expect(await status(callId)).toBe('missed');
    expect((await maya.post('/api/calls', { conversationId, type: 'voice' })).status).toBe(201);
  });

  it('an active call without heartbeats is ended; a live one is kept', async () => {
    const live = await ringing();
    await live.jonas.post(`/api/calls/${live.callId}/accept`);
    const silent = await ringing();
    await silent.jonas.post(`/api/calls/${silent.callId}/accept`);
    await t.client.query(`update calls set last_heartbeat_at = now() - make_interval(secs => $2) where id = $1`, [silent.callId, CALL_STALE_SECONDS + 1]);

    await createCallStore(t.db).expireStale();

    expect(await status(silent.callId)).toBe('ended');
    expect(await status(live.callId)).toBe('active');
    const { rows } = await t.client.query('select 1 from call_participants where call_id = $1 and left_at is null and joined_at is not null', [silent.callId]);
    expect(rows).toEqual([]);
  });
});

describe('GET /api/calls/ongoing and /:callId', () => {
  it('lists the user’s ringing and active calls only', async () => {
    const { maya, jonas, callId } = await ringing();
    const outsider = await user();

    expect(callListSchema.parse((await jonas.get('/api/calls/ongoing')).body).calls.map((c) => c.id)).toEqual([callId]);
    expect((await maya.get('/api/calls/ongoing')).body.calls).toHaveLength(1);
    expect((await outsider.get('/api/calls/ongoing')).body.calls).toEqual([]);

    await jonas.post(`/api/calls/${callId}/decline`);
    expect((await jonas.get('/api/calls/ongoing')).body.calls).toEqual([]);
    expect((await jonas.get(`/api/calls/${callId}`)).body.status).toBe('declined'); // history stays visible
  });

  it('serves ICE servers to signed-in users only, never cached', async () => {
    const maya = await user();
    expect((await request(app).get('/api/calls/ice-servers')).status).toBe(401);
    const res = await maya.get('/api/calls/ice-servers');
    expect(iceServersResponseSchema.parse(res.body)).toEqual({ iceServers });
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('answers 503 without a database', async () => {
    const noDb = createApp({ verifyAccessToken: auth.verifyAccessToken, calls: null });
    const id = await t.createUser();
    const res = await request(noDb).get('/api/calls/ongoing').set('Authorization', `Bearer ${await auth.tokenFor(id)}`);
    expect(res.status).toBe(503);
  });
});
