import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationListSchema, conversationSchema, type Conversation } from '@linka/shared';
import { createApp } from '../app.js';
import { createConversationStore } from '../services/conversations.js';
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
    checkDatabase: async () => 'connected',
    verifyAccessToken: auth.verifyAccessToken,
    profiles: createProfileStore(t.db),
    conversations: createConversationStore(t.db),
  });
});

afterAll(async () => {
  await t.close();
});

/** A user with a profile, plus helpers that call the API as them. */
async function user() {
  const id = await t.createUser();
  const authorization = `Bearer ${await auth.tokenFor(id)}`;
  return {
    id,
    get: (path: string) => request(app).get(path).set('Authorization', authorization),
    post: (path: string, body?: object) => request(app).post(path).set('Authorization', authorization).send(body),
    patch: (path: string, body?: object) => request(app).patch(path).set('Authorization', authorization).send(body),
    delete: (path: string) => request(app).delete(path).set('Authorization', authorization),
  };
}
type User = Awaited<ReturnType<typeof user>>;

async function group(owner: User, members: User[], name = 'Weekend trip'): Promise<Conversation> {
  const res = await owner.post('/api/conversations', { type: 'group', name, memberIds: members.map((m) => m.id) });
  expect(res.status).toBe(201);
  return conversationSchema.parse(res.body);
}

const roleOf = (conversation: Conversation, userId: string) =>
  conversation.members.find((m) => m.userId === userId)?.role;

describe('authentication', () => {
  it('rejects unauthenticated requests on every conversation route', async () => {
    const id = randomUUID();
    const responses = await Promise.all([
      request(app).get('/api/conversations'),
      request(app).post('/api/conversations').send({ type: 'direct', userId: id }),
      request(app).get(`/api/conversations/${id}`),
      request(app).patch(`/api/conversations/${id}`).send({ name: 'x' }),
      request(app).post(`/api/conversations/${id}/members`).send({ userIds: [id] }),
      request(app).delete(`/api/conversations/${id}/members/${id}`),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
  });
});

describe('creating conversations', () => {
  it('creates a group with the caller as owner and everyone else as members', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const conversation = await group(maya, [jonas, priya]);

    expect(conversation).toMatchObject({ type: 'group', name: 'Weekend trip' });
    expect(conversation.members).toHaveLength(3);
    expect(roleOf(conversation, maya.id)).toBe('owner');
    expect(roleOf(conversation, jonas.id)).toBe('member');
    expect(roleOf(conversation, priya.id)).toBe('member');
  });

  it('exposes only public profile fields of members (no email)', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await group(maya, [jonas]);

    expect(Object.keys(conversation.members[0]!).sort()).toEqual(
      ['avatarPath', 'displayName', 'joinedAt', 'role', 'userId', 'username'].sort(),
    );
    expect(JSON.stringify(conversation)).not.toContain('@example.test');
  });

  it('ignores the creator listed among the members and duplicate ids', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const res = await maya.post('/api/conversations', {
      type: 'group',
      name: 'Dupes',
      memberIds: [jonas.id, jonas.id, maya.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.members).toHaveLength(2);
    expect(roleOf(res.body, maya.id)).toBe('owner');
  });

  it('cannot name someone else as the creator', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const res = await maya.post('/api/conversations', {
      type: 'group',
      name: 'Spoof',
      memberIds: [jonas.id],
      createdBy: jonas.id,
    });
    expect(res.status).toBe(400);
  });

  it('rejects members that do not exist', async () => {
    const maya = await user();
    const res = await maya.post('/api/conversations', { type: 'group', name: 'Ghosts', memberIds: [randomUUID()] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', fields: { memberIds: 'That user does not exist.' } });
  });

  it('rejects a user who signed up but never created a profile', async () => {
    const maya = await user();
    const noProfile = await t.createAuthUser();
    const res = await maya.post('/api/conversations', { type: 'direct', userId: noProfile });
    expect(res.status).toBe(400);
  });

  it('creates a 1:1 conversation with exactly two members', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const res = await maya.post('/api/conversations', { type: 'direct', userId: jonas.id });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'direct', name: null });
    expect(res.body.members.map((m: { userId: string }) => m.userId).sort()).toEqual([maya.id, jonas.id].sort());
  });

  it('returns the existing 1:1 conversation instead of creating a duplicate, from either side', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const first = await maya.post('/api/conversations', { type: 'direct', userId: jonas.id });
    const again = await maya.post('/api/conversations', { type: 'direct', userId: jonas.id });
    const reverse = await jonas.post('/api/conversations', { type: 'direct', userId: maya.id });

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(reverse.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(reverse.body.id).toBe(first.body.id);
  });

  it('handles both people starting the same 1:1 conversation at once', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const [a, b] = await Promise.all([
      maya.post('/api/conversations', { type: 'direct', userId: jonas.id }),
      jonas.post('/api/conversations', { type: 'direct', userId: maya.id }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
  });

  it('rejects a 1:1 conversation with yourself or with several people', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);

    expect((await maya.post('/api/conversations', { type: 'direct', userId: maya.id })).status).toBe(400);
    expect(
      (await maya.post('/api/conversations', { type: 'direct', userId: jonas.id, memberIds: [priya.id] })).status,
    ).toBe(400);
  });

  it('rejects unknown conversation types', async () => {
    const maya = await user();
    expect((await maya.post('/api/conversations', { type: 'channel', name: 'x', memberIds: [] })).status).toBe(400);
  });
});

describe('reading conversations', () => {
  it('lists only the caller’s conversations', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const shared = await group(maya, [jonas]);
    await group(outsider, [await user()], 'Not yours');

    const list = conversationListSchema.parse((await jonas.get('/api/conversations')).body);
    expect(list.conversations.map((c) => c.id)).toEqual([shared.id]);
  });

  it('lets members read a conversation', async () => {
    const [maya, jonas] = await Promise.all([user(), user()]);
    const conversation = await group(maya, [jonas]);

    const res = await jonas.get(`/api/conversations/${conversation.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(conversation.id);
  });

  it('answers 404 to non-members, exactly like a conversation that does not exist', async () => {
    const [maya, jonas, outsider] = await Promise.all([user(), user(), user()]);
    const conversation = await group(maya, [jonas]);

    const notMine = await outsider.get(`/api/conversations/${conversation.id}`);
    const missing = await outsider.get(`/api/conversations/${randomUUID()}`);
    const malformed = await outsider.get('/api/conversations/not-a-uuid');

    for (const res of [notMine, missing, malformed]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
    }
  });

  it('marks responses as private', async () => {
    const maya = await user();
    expect((await maya.get('/api/conversations')).headers['cache-control']).toBe('private, no-store');
  });
});

describe('group management', () => {
  it('owner and admins can rename the group, members cannot', async () => {
    const [owner, admin, member] = await Promise.all([user(), user(), user()]);
    const conversation = await group(owner, [admin, member]);
    await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'admin' });

    expect((await owner.patch(`/api/conversations/${conversation.id}`, { name: 'By owner' })).status).toBe(200);
    expect((await admin.patch(`/api/conversations/${conversation.id}`, { name: 'By admin' })).body.name).toBe('By admin');

    const denied = await member.patch(`/api/conversations/${conversation.id}`, { name: 'By member' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
  });

  it('1:1 conversations cannot be renamed or managed', async () => {
    const [maya, jonas, priya] = await Promise.all([user(), user(), user()]);
    const direct = (await maya.post('/api/conversations', { type: 'direct', userId: jonas.id })).body as Conversation;

    expect((await maya.patch(`/api/conversations/${direct.id}`, { name: 'Named' })).status).toBe(400);
    expect((await maya.post(`/api/conversations/${direct.id}/members`, { userIds: [priya.id] })).status).toBe(400);
    expect((await maya.delete(`/api/conversations/${direct.id}/members/${maya.id}`)).status).toBe(400);
  });

  it('owner and admins can add members; members cannot', async () => {
    const [owner, admin, member, newA, newB] = await Promise.all([user(), user(), user(), user(), user()]);
    const conversation = await group(owner, [admin, member]);
    await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'admin' });

    expect((await admin.post(`/api/conversations/${conversation.id}/members`, { userIds: [newA.id] })).status).toBe(200);
    const denied = await member.post(`/api/conversations/${conversation.id}/members`, { userIds: [newB.id] });
    expect(denied.status).toBe(403);

    const after = (await owner.get(`/api/conversations/${conversation.id}`)).body as Conversation;
    expect(roleOf(after, newA.id)).toBe('member');
    expect(roleOf(after, newB.id)).toBeUndefined();
  });

  it('refuses to add someone who is already a member', async () => {
    const [owner, member] = await Promise.all([user(), user()]);
    const conversation = await group(owner, [member]);

    const res = await owner.post(`/api/conversations/${conversation.id}/members`, { userIds: [member.id] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('non-members cannot add themselves', async () => {
    const [owner, member, outsider] = await Promise.all([user(), user(), user()]);
    const conversation = await group(owner, [member]);

    const res = await outsider.post(`/api/conversations/${conversation.id}/members`, { userIds: [outsider.id] });
    expect(res.status).toBe(404);
  });

  it('admins can remove regular members, but not other admins or the owner', async () => {
    const [owner, adminA, adminB, member] = await Promise.all([user(), user(), user(), user()]);
    const conversation = await group(owner, [adminA, adminB, member]);
    for (const admin of [adminA, adminB]) {
      await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'admin' });
    }

    expect((await adminA.delete(`/api/conversations/${conversation.id}/members/${adminB.id}`)).status).toBe(403);
    expect((await adminA.delete(`/api/conversations/${conversation.id}/members/${owner.id}`)).status).toBe(403);
    expect((await adminA.delete(`/api/conversations/${conversation.id}/members/${member.id}`)).status).toBe(204);
  });

  it('members cannot remove anyone', async () => {
    const [owner, memberA, memberB] = await Promise.all([user(), user(), user()]);
    const conversation = await group(owner, [memberA, memberB]);

    expect((await memberA.delete(`/api/conversations/${conversation.id}/members/${memberB.id}`)).status).toBe(403);
  });

  it('the owner can remove admins and members', async () => {
    const [owner, admin, member] = await Promise.all([user(), user(), user()]);
    const conversation = await group(owner, [admin, member]);
    await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'admin' });

    expect((await owner.delete(`/api/conversations/${conversation.id}/members/${admin.id}`)).status).toBe(204);
    expect((await owner.delete(`/api/conversations/${conversation.id}/members/${member.id}`)).status).toBe(204);
    expect((await admin.get(`/api/conversations/${conversation.id}`)).status).toBe(404);
  });

  it('members and admins can leave; the owner must transfer ownership first', async () => {
    const [owner, member] = await Promise.all([user(), user()]);
    const conversation = await group(owner, [member]);

    expect((await member.delete(`/api/conversations/${conversation.id}/members/${member.id}`)).status).toBe(204);
    expect((await member.get(`/api/conversations/${conversation.id}`)).status).toBe(404);

    const ownerLeaves = await owner.delete(`/api/conversations/${conversation.id}/members/${owner.id}`);
    expect(ownerLeaves.status).toBe(409);
    expect(ownerLeaves.body.error.code).toBe('OWNER_CANNOT_LEAVE');
  });

  it('answers 404 when removing someone who is not in the group', async () => {
    const [owner, member, stranger] = await Promise.all([user(), user(), user()]);
    const conversation = await group(owner, [member]);

    const res = await owner.delete(`/api/conversations/${conversation.id}/members/${stranger.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MEMBER_NOT_FOUND');
  });
});

describe('roles and ownership', () => {
  it('only the owner can promote and demote', async () => {
    const [owner, admin, member] = await Promise.all([user(), user(), user()]);
    const conversation = await group(owner, [admin, member]);

    const promoted = await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'admin' });
    expect(roleOf(promoted.body, admin.id)).toBe('admin');

    expect((await admin.patch(`/api/conversations/${conversation.id}/members/${member.id}`, { role: 'admin' })).status).toBe(403);
    expect((await member.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'member' })).status).toBe(403);

    const demoted = await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'member' });
    expect(roleOf(demoted.body, admin.id)).toBe('member');
  });

  it('nobody can demote the owner, including the owner', async () => {
    const [owner, admin] = await Promise.all([user(), user()]);
    const conversation = await group(owner, [admin]);
    await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'admin' });

    expect((await admin.patch(`/api/conversations/${conversation.id}/members/${owner.id}`, { role: 'member' })).status).toBe(403);
    expect((await owner.patch(`/api/conversations/${conversation.id}/members/${owner.id}`, { role: 'member' })).status).toBe(403);
  });

  it('transferring ownership makes the old owner an admin, who can then leave', async () => {
    const [owner, member] = await Promise.all([user(), user()]);
    const conversation = await group(owner, [member]);

    const res = await owner.patch(`/api/conversations/${conversation.id}/members/${member.id}`, { role: 'owner' });
    expect(res.status).toBe(200);
    expect(roleOf(res.body, member.id)).toBe('owner');
    expect(roleOf(res.body, owner.id)).toBe('admin');
    expect(res.body.members.filter((m: { role: string }) => m.role === 'owner')).toHaveLength(1);

    expect((await owner.delete(`/api/conversations/${conversation.id}/members/${owner.id}`)).status).toBe(204);
  });

  it('admins cannot transfer ownership', async () => {
    const [owner, admin, member] = await Promise.all([user(), user(), user()]);
    const conversation = await group(owner, [admin, member]);
    await owner.patch(`/api/conversations/${conversation.id}/members/${admin.id}`, { role: 'admin' });

    expect((await admin.patch(`/api/conversations/${conversation.id}/members/${member.id}`, { role: 'owner' })).status).toBe(403);
  });

  it('rejects unknown roles', async () => {
    const [owner, member] = await Promise.all([user(), user()]);
    const conversation = await group(owner, [member]);

    expect((await owner.patch(`/api/conversations/${conversation.id}/members/${member.id}`, { role: 'superuser' })).status).toBe(400);
  });
});
