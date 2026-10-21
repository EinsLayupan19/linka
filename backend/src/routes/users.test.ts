import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorResponseSchema, profileSchema } from '@linka/shared';
import { createApp } from '../app.js';
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
  });
});

afterAll(async () => {
  await t.close();
});

/** A signed-up user (row in auth.users) and a valid access token for them. */
async function signedInUser() {
  const id = await t.createAuthUser();
  return { id, authorization: `Bearer ${await auth.tokenFor(id)}` };
}

describe('authentication on /api/users/me', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(401);
    expect(apiErrorResponseSchema.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a non-Bearer authorization header', async () => {
    const res = await request(app).get('/api/users/me').set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token', async () => {
    const res = await request(app).get('/api/users/me').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const id = await t.createAuthUser();
    const token = await auth.tokenFor(id, { expiresAt: Math.floor(Date.now() / 1000) - 5 });

    const res = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('answers 503 when authentication is not configured', async () => {
    const unconfigured = createApp({ verifyAccessToken: null, profiles: createProfileStore(t.db) });
    const res = await request(unconfigured).get('/api/users/me').set('Authorization', 'Bearer anything');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers 503 when the database is not configured', async () => {
    const noDb = createApp({ verifyAccessToken: auth.verifyAccessToken, profiles: null });
    const { authorization } = await signedInUser();

    const res = await request(noDb).get('/api/users/me').set('Authorization', authorization);
    expect(res.status).toBe(503);
  });
});

describe('profile lifecycle', () => {
  it('404s before setup, creates the profile for the token’s user, then returns it', async () => {
    const user = await signedInUser();

    const before = await request(app).get('/api/users/me').set('Authorization', user.authorization);
    expect(before.status).toBe(404);
    expect(before.body.error.code).toBe('PROFILE_NOT_FOUND');

    const created = await request(app)
      .post('/api/users/me')
      .set('Authorization', user.authorization)
      .send({ username: '  Maya_Reyes ', displayName: 'Maya Reyes' });
    expect(created.status).toBe(201);
    expect(profileSchema.parse(created.body)).toMatchObject({ id: user.id, username: 'maya_reyes' });

    const after = await request(app).get('/api/users/me').set('Authorization', user.authorization);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(created.body);
  });

  it('marks profile responses as private and uncacheable', async () => {
    const user = await signedInUser();
    const res = await request(app).get('/api/users/me').set('Authorization', user.authorization);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('updates the display name', async () => {
    const user = await signedInUser();
    await request(app)
      .post('/api/users/me')
      .set('Authorization', user.authorization)
      .send({ username: 'jonas', displayName: 'Jonas' });

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', user.authorization)
      .send({ displayName: 'Jonas Lindqvist' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: 'jonas', displayName: 'Jonas Lindqvist' });
  });

  it('404s when updating before the profile exists', async () => {
    const user = await signedInUser();
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', user.authorization)
      .send({ displayName: 'Nobody' });
    expect(res.status).toBe(404);
  });
});

describe('profile authorization', () => {
  it('rejects a client-supplied id instead of trusting it', async () => {
    const victim = await signedInUser();
    const attacker = await signedInUser();

    const res = await request(app)
      .post('/api/users/me')
      .set('Authorization', attacker.authorization)
      .send({ id: victim.id, username: 'impostor', displayName: 'Impostor' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((await request(app).get('/api/users/me').set('Authorization', victim.authorization)).status).toBe(404);
  });

  it('only ever reads and changes the caller’s own profile', async () => {
    const maya = await signedInUser();
    const jonas = await signedInUser();
    await request(app)
      .post('/api/users/me')
      .set('Authorization', maya.authorization)
      .send({ username: 'maya_only', displayName: 'Maya' });

    // Jonas has no profile: he gets his own 404, never Maya's data.
    expect((await request(app).get('/api/users/me').set('Authorization', jonas.authorization)).status).toBe(404);

    await request(app).patch('/api/users/me').set('Authorization', jonas.authorization).send({ displayName: 'Hacked' });
    const mayaProfile = await request(app).get('/api/users/me').set('Authorization', maya.authorization);
    expect(mayaProfile.body.displayName).toBe('Maya');
  });

  it('cannot change the username through an update', async () => {
    const user = await signedInUser();
    await request(app)
      .post('/api/users/me')
      .set('Authorization', user.authorization)
      .send({ username: 'stable_name', displayName: 'Stable' });

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', user.authorization)
      .send({ displayName: 'Stable', username: 'new_name' });
    expect(res.status).toBe(400);
  });
});

describe('profile input validation', () => {
  it('returns per-field errors for invalid input', async () => {
    const user = await signedInUser();
    const res = await request(app)
      .post('/api/users/me')
      .set('Authorization', user.authorization)
      .send({ username: 'no spaces!', displayName: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: {
        username: 'Use only letters, numbers and underscores.',
        displayName: 'Enter a display name.',
      },
    });
  });

  it('rejects a missing body', async () => {
    const user = await signedInUser();
    const res = await request(app).post('/api/users/me').set('Authorization', user.authorization);
    expect(res.status).toBe(400);
  });

  it('reports a taken username on the username field', async () => {
    const first = await signedInUser();
    const second = await signedInUser();
    await request(app)
      .post('/api/users/me')
      .set('Authorization', first.authorization)
      .send({ username: 'popular', displayName: 'First' });

    const res = await request(app)
      .post('/api/users/me')
      .set('Authorization', second.authorization)
      .send({ username: 'Popular', displayName: 'Second' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'USERNAME_TAKEN', fields: { username: 'That username is taken.' } });
  });
});

describe('CORS for authenticated requests', () => {
  it('allows the Authorization header in preflight from the frontend origin', async () => {
    const res = await request(app)
      .options('/api/users/me')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
    expect(res.headers['access-control-allow-methods']).toMatch(/PATCH/);
  });
});
