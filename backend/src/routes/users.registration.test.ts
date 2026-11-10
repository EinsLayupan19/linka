import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createProfileStore, type ProfileStore } from '../services/profiles.js';
import { createTestAuth } from '../test/auth.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

/**
 * The second half of registration: Supabase has created the auth account, and the user now
 * creates their profile (POST /api/users/me, from the onboarding page). These tests cover what
 * happens when that step is repeated, raced or fails.
 */
let t: TestDatabase;
let auth: Awaited<ReturnType<typeof createTestAuth>>;

beforeAll(async () => {
  t = await createTestDatabase();
  auth = await createTestAuth();
});

afterAll(async () => {
  await t.close();
});

function appWith(profiles: ProfileStore) {
  return createApp({ checkDatabase: async () => 'connected', verifyAccessToken: auth.verifyAccessToken, profiles });
}

async function signedUpUser() {
  const id = await t.createAuthUser();
  return { id, authorization: `Bearer ${await auth.tokenFor(id)}` };
}

async function profileRows(userId: string): Promise<number> {
  const { rows } = await t.client.query<{ n: number }>('select count(*)::int as n from profiles where id = $1', [userId]);
  return rows[0]!.n;
}

describe('profile creation during registration', () => {
  it('treats a retried request (the first answer was lost) as already done, with one profile', async () => {
    const app = appWith(createProfileStore(t.db));
    const user = await signedUpUser();
    const body = { username: 'retry_user', displayName: 'Retry User' };

    const first = await request(app).post('/api/users/me').set('Authorization', user.authorization).send(body);
    const retry = await request(app).post('/api/users/me').set('Authorization', user.authorization).send(body);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('PROFILE_EXISTS');
    expect(await profileRows(user.id)).toBe(1);
  });

  it('creates exactly one profile when the form is submitted twice at once', async () => {
    const app = appWith(createProfileStore(t.db));
    const user = await signedUpUser();
    const body = { username: 'double_click', displayName: 'Double Click' };

    const answers = await Promise.all([
      request(app).post('/api/users/me').set('Authorization', user.authorization).send(body),
      request(app).post('/api/users/me').set('Authorization', user.authorization).send(body),
    ]);

    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    expect(answers.find((a) => a.status === 409)!.body.error.code).toBe('PROFILE_EXISTS');
    expect(await profileRows(user.id)).toBe(1);
  });

  it('answers a database failure with a generic 500 that leaks nothing, and a retry then succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = createProfileStore(t.db);
    const broken: ProfileStore = {
      ...real,
      create: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:6543 (postgres://linka:secret@db.internal/postgres)');
      },
    };
    const user = await signedUpUser();
    const body = { username: 'after_outage', displayName: 'After Outage' };

    const failed = await request(appWith(broken)).post('/api/users/me').set('Authorization', user.authorization).send(body);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(JSON.stringify(failed.body)).not.toMatch(/ECONNREFUSED|secret|postgres/);
    expect(await profileRows(user.id)).toBe(0);

    const retried = await request(appWith(real)).post('/api/users/me').set('Authorization', user.authorization).send(body);
    expect(retried.status).toBe(201);
    expect(await profileRows(user.id)).toBe(1);
  });

  it('keeps a signed-up user without a profile in a clear "set up your profile" state', async () => {
    const app = appWith(createProfileStore(t.db));
    const user = await signedUpUser();

    const res = await request(app).get('/api/users/me').set('Authorization', user.authorization);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
  });
});
