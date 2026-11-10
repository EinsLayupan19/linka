import { describe, expect, it } from 'vitest';
import { createMemoryStorage, sampleFiles } from '../test/storage.js';
import { AVATAR_URL_MIN_REMAINING_SECONDS, AVATAR_URL_TTL_SECONDS, createMediaUrls } from './media.js';

/** Memory storage holding the given avatars, counting how often URLs are signed. */
function storageWith(paths: string[]) {
  const storage = createMemoryStorage();
  for (const path of paths) storage.putObject('avatars', path, sampleFiles.png(), 'image/png');
  const signed: string[][] = [];
  let version = 0;
  const signedUrls = storage.signedUrls.bind(storage);
  storage.signedUrls = async (bucket, toSign, expiresInSeconds) => {
    signed.push([...toSign]);
    version += 1;
    // Like Supabase: every signing call returns a different URL (a new token).
    const urls = await signedUrls(bucket, toSign, expiresInSeconds);
    return new Map([...urls].map(([path, url]) => [path, `${url}&v=${version}`]));
  };
  return { storage, signed };
}

describe('createMediaUrls', () => {
  it('returns the same URL for the same picture on later requests, so browsers can cache it', async () => {
    const { storage } = storageWith(['u1/a.png']);
    const media = createMediaUrls(storage);

    const first = await media.avatarUrls(['u1/a.png']);
    const second = await media.avatarUrls(['u1/a.png']);

    expect(first.get('u1/a.png')).toBeDefined();
    expect(second.get('u1/a.png')).toBe(first.get('u1/a.png'));
  });

  it('only asks Storage to sign pictures it has no usable URL for', async () => {
    const { storage, signed } = storageWith(['u1/a.png', 'u2/b.png']);
    const media = createMediaUrls(storage);

    await media.avatarUrls(['u1/a.png']);
    const urls = await media.avatarUrls(['u1/a.png', 'u2/b.png', null, 'u2/b.png']);

    expect(signed).toEqual([['u1/a.png'], ['u2/b.png']]);
    expect([...urls.keys()].sort()).toEqual(['u1/a.png', 'u2/b.png']);
  });

  it('makes no Storage call when every picture is cached', async () => {
    const { storage, signed } = storageWith(['u1/a.png']);
    const media = createMediaUrls(storage);

    await media.avatarUrls(['u1/a.png']);
    await media.avatarUrls(['u1/a.png']);

    expect(signed).toHaveLength(1);
  });

  it('signs a fresh URL once the cached one is close to expiring', async () => {
    const { storage, signed } = storageWith(['u1/a.png']);
    let now = 1_000_000;
    const media = createMediaUrls(storage, { now: () => now });

    const first = await media.avatarUrls(['u1/a.png']);
    // Still plenty of time left: reused.
    now += (AVATAR_URL_TTL_SECONDS - AVATAR_URL_MIN_REMAINING_SECONDS - 1) * 1000;
    expect((await media.avatarUrls(['u1/a.png'])).get('u1/a.png')).toBe(first.get('u1/a.png'));
    // Less than the minimum left: a client could get a URL that dies soon, so sign again.
    now += 2000;
    const renewed = await media.avatarUrls(['u1/a.png']);

    expect(signed).toHaveLength(2);
    expect(renewed.get('u1/a.png')).not.toBe(first.get('u1/a.png'));
  });

  it('still returns cached URLs when Storage fails, and does not cache the failure', async () => {
    const { storage } = storageWith(['u1/a.png', 'u2/b.png']);
    const media = createMediaUrls(storage);
    const cached = await media.avatarUrls(['u1/a.png']);

    storage.failNext('signedUrls');
    const during = await media.avatarUrls(['u1/a.png', 'u2/b.png']);
    const after = await media.avatarUrls(['u2/b.png']);

    expect(during.get('u1/a.png')).toBe(cached.get('u1/a.png'));
    expect(during.has('u2/b.png')).toBe(false);
    expect(after.has('u2/b.png')).toBe(true);
  });

  it('keeps the cache bounded by dropping the oldest entries', async () => {
    const { storage, signed } = storageWith(['a.png', 'b.png', 'c.png']);
    const media = createMediaUrls(storage, { maxEntries: 2 });

    await media.avatarUrls(['a.png']);
    await media.avatarUrls(['b.png']);
    await media.avatarUrls(['c.png']); // pushes out a.png
    await media.avatarUrls(['b.png', 'c.png']); // both still cached
    await media.avatarUrls(['a.png']); // signed again

    expect(signed).toEqual([['a.png'], ['b.png'], ['c.png'], ['a.png']]);
  });

  it('returns nothing without storage', async () => {
    expect((await createMediaUrls(null).avatarUrls(['u1/a.png'])).size).toBe(0);
  });
});
