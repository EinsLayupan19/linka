import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createTestAuth } from '../test/auth.js';

/**
 * Linka's clients never send compressed request bodies, so the API does not decompress them at
 * all. That removes a denial-of-service path in body decompression (GHSA-27r3-jxmh-p828) for
 * everyone, signed in or not, whatever the body-parser version.
 */
let auth: Awaited<ReturnType<typeof createTestAuth>>;

beforeAll(async () => {
  auth = await createTestAuth();
});

const gzippedJson = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)));

describe('compressed request bodies', () => {
  it('refuses a gzip JSON body before anything else, even without signing in', async () => {
    const res = await request(createApp())
      .post('/api/users/me')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzippedJson({ username: 'maya', displayName: 'Maya' }));

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Compressed request bodies are not accepted.' } });
  });

  it('refuses a deflate JSON body the same way', async () => {
    const res = await request(createApp())
      .post('/api/conversations')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'deflate')
      .send(gzippedJson({ type: 'direct', userId: '8e0a2c4d-6f8b-4a1c-9e3d-5f7b9d1f3a5c' }));

    expect(res.status).toBe(415);
  });

  it('refuses a compressed profile picture upload', async () => {
    const authorization = `Bearer ${await auth.tokenFor('6a1c3e5f-7b9d-4f2a-8c4e-0d2f4a6c8e1b')}`;
    const res = await request(createApp({ verifyAccessToken: auth.verifyAccessToken }))
      .put('/api/users/me/avatar')
      .set('Authorization', authorization)
      .set('Content-Type', 'image/png')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(Buffer.alloc(64)));

    expect(res.status).toBe(415);
  });

  it('is a client error, not a server failure: nothing is logged as an error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(createApp())
      .post('/api/users/me')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzippedJson({}));
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('still accepts ordinary JSON bodies', async () => {
    const res = await request(createApp())
      .post('/api/users/me')
      .set('Content-Type', 'application/json')
      .send({ username: 'maya', displayName: 'Maya' });

    // Reaches authentication as usual (no token here), instead of being refused as compressed.
    expect(res.status).not.toBe(415);
  });
});
