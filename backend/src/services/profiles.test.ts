import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { AppError } from '../utils/AppError.js';
import { createProfileStore, type ProfileStore } from './profiles.js';

let t: TestDatabase;
let store: ProfileStore;

beforeAll(async () => {
  t = await createTestDatabase();
  store = createProfileStore(t.db);
});

afterAll(async () => {
  await t.close();
});

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode: status, code });
  return error as AppError;
}

describe('profile store', () => {
  it('returns null for a user without a profile', async () => {
    expect(await store.findById(await t.createAuthUser())).toBeNull();
  });

  it('creates a profile for the user and returns it', async () => {
    const userId = await t.createAuthUser();
    const profile = await store.create(userId, { username: 'maya', displayName: 'Maya Reyes' });

    expect(profile).toMatchObject({ id: userId, username: 'maya', displayName: 'Maya Reyes', avatarUrl: null });
    expect(new Date(profile.createdAt).getTime()).not.toBeNaN();
    expect(await store.findById(userId)).toEqual(profile);
  });

  it('refuses a second profile for the same user', async () => {
    const userId = await t.createAuthUser();
    await store.create(userId, { username: 'first_one', displayName: 'First' });

    await expectAppError(store.create(userId, { username: 'second_one', displayName: 'Second' }), 409, 'PROFILE_EXISTS');
  });

  it('refuses a username that belongs to someone else, with a field error', async () => {
    await store.create(await t.createAuthUser(), { username: 'taken', displayName: 'Owner' });

    const error = await expectAppError(
      store.create(await t.createAuthUser(), { username: 'taken', displayName: 'Copycat' }),
      409,
      'USERNAME_TAKEN',
    );
    expect(error.fields).toEqual({ username: 'That username is taken.' });
  });

  it('answers 401 when the auth user no longer exists', async () => {
    await expectAppError(
      store.create('7c9e6679-7425-40de-944b-e07fc1f90ae7', { username: 'ghost', displayName: 'Ghost' }),
      401,
      'UNAUTHORIZED',
    );
  });

  it('updates only the given user’s display name and bumps updatedAt', async () => {
    const maya = await t.createAuthUser();
    const jonas = await t.createAuthUser();
    const before = await store.create(maya, { username: 'maya_r', displayName: 'Maya' });
    await store.create(jonas, { username: 'jonas_l', displayName: 'Jonas' });

    const after = await store.update(maya, { displayName: 'Maya R.' });

    expect(after).toMatchObject({ id: maya, displayName: 'Maya R.', username: 'maya_r' });
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
    expect((await store.findById(jonas))?.displayName).toBe('Jonas');
  });

  it('returns null when updating a user without a profile', async () => {
    expect(await store.update(await t.createAuthUser(), { displayName: 'Nobody' })).toBeNull();
  });
});
