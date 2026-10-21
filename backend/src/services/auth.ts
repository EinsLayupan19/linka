import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { ErrorCode } from '@linka/shared';
import { AppError } from '../utils/AppError.js';

/** The user behind a verified access token. Always derived from the token, never from the request body. */
export interface AuthUser {
  userId: string;
  email: string | null;
}

export type VerifyAccessToken = (token: string) => Promise<AuthUser>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// jose errors that mean "this token is not acceptable" (as opposed to "we could not check it").
const INVALID_TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

const invalidSession = () => new AppError(401, ErrorCode.Unauthorized, 'Your session is invalid or has expired.');

function toAuthUser(payload: JWTPayload): AuthUser {
  // Only real signed-in users: not the anon key, not anonymous sign-ins.
  if (payload.role !== 'authenticated' || payload.is_anonymous === true) throw invalidSession();
  if (typeof payload.sub !== 'string' || !UUID_PATTERN.test(payload.sub)) throw invalidSession();
  return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

/**
 * Verifies Supabase access tokens: signature, issuer, audience, expiry and claims.
 * `keys` resolves the signing key; production uses the project's public JWKS.
 */
export function createAccessTokenVerifier(options: { issuer: string; keys: JWTVerifyGetKey }): VerifyAccessToken {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        issuer: options.issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
      });
      return toAuthUser(payload);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (INVALID_TOKEN_ERRORS.some((type) => error instanceof type)) throw invalidSession();
      // The signing keys could not be fetched (network/Supabase problem): not the user's fault.
      console.error('Access token verification failed:', error instanceof Error ? error.message : error);
      throw new AppError(503, ErrorCode.ServiceUnavailable, 'Could not verify your session. Try again shortly.');
    }
  };
}

/** Verifier for a Supabase project. jose caches the keys, so most requests need no network call. */
export function createSupabaseTokenVerifier(supabaseUrl: string): VerifyAccessToken {
  const issuer = `${supabaseUrl}/auth/v1`;
  return createAccessTokenVerifier({
    issuer,
    keys: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
  });
}
