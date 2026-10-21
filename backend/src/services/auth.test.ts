import { randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth, TEST_ISSUER } from '../test/auth.js';
import { AppError } from '../utils/AppError.js';
import { createAccessTokenVerifier } from './auth.js';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
const userId = randomUUID();

beforeAll(async () => {
  auth = await createTestAuth();
});

async function expectRejected(token: string, status = 401) {
  const error = await auth.verifyAccessToken(token).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).statusCode).toBe(status);
}

describe('access token verification', () => {
  it('accepts a valid token and takes the user id from its subject', async () => {
    const token = await auth.tokenFor(userId, { claims: { email: 'maya@example.test' } });
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({ userId, email: 'maya@example.test' });
  });

  it('rejects an expired token', async () => {
    await expectRejected(await auth.tokenFor(userId, { expiresAt: Math.floor(Date.now() / 1000) - 60 }));
  });

  it('rejects a token signed by a different key', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    await expectRejected(await auth.tokenFor(userId, { signWith: privateKey }));
  });

  it('rejects a token from another project (issuer)', async () => {
    await expectRejected(await auth.tokenFor(userId, { issuer: 'https://other.supabase.co/auth/v1' }));
  });

  it('rejects a token with the wrong audience', async () => {
    await expectRejected(await auth.tokenFor(userId, { audience: 'something-else' }));
  });

  it('rejects the anon role (e.g. the public publishable key)', async () => {
    await expectRejected(await auth.tokenFor(userId, { claims: { role: 'anon' } }));
  });

  it('rejects anonymous sign-ins', async () => {
    await expectRejected(await auth.tokenFor(userId, { claims: { is_anonymous: true } }));
  });

  it('rejects a subject that is not a user id', async () => {
    await expectRejected(await auth.tokenFor('not-a-uuid'));
  });

  it('rejects an HS256 token even if it carries valid-looking claims', async () => {
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(TEST_ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-guessable-shared-secret-value!'));
    await expectRejected(token);
  });

  it('rejects malformed tokens', async () => {
    await expectRejected('not.a.jwt');
    await expectRejected('garbage');
  });

  it('answers 503 (not 401) when the signing keys cannot be fetched', async () => {
    const verify = createAccessTokenVerifier({
      issuer: TEST_ISSUER,
      keys: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const error = await verify(await auth.tokenFor(userId)).catch((e: unknown) => e);
      expect((error as AppError).statusCode).toBe(503);
    } finally {
      console.error = originalError;
    }
  });
});
