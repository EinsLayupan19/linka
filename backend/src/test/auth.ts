import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import { createAccessTokenVerifier } from '../services/auth.js';

export const TEST_ISSUER = 'https://test-project.supabase.co/auth/v1';

interface TokenOptions {
  claims?: JWTPayload;
  issuer?: string;
  audience?: string;
  /** Expiry as a jose time span ("1h") or an epoch timestamp in seconds. */
  expiresAt?: string | number;
  signWith?: CryptoKey;
}

/**
 * A fake Supabase project: a real ES256 key pair, a verifier that trusts its public key,
 * and a helper that signs access tokens shaped like Supabase's.
 */
export async function createTestAuth() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };

  const verifyAccessToken = createAccessTokenVerifier({
    issuer: TEST_ISSUER,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });

  function tokenFor(userId: string, options: TokenOptions = {}): Promise<string> {
    return new SignJWT({ role: 'authenticated', email: `${userId}@example.test`, ...options.claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(userId)
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setAudience(options.audience ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(options.expiresAt ?? '1h')
      .sign(options.signWith ?? privateKey);
  }

  return { verifyAccessToken, tokenFor };
}
