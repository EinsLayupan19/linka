import type { Request, RequestHandler } from 'express';
import { ErrorCode } from '@linka/shared';
import type { AuthUser, VerifyAccessToken } from '../services/auth.js';
import { AppError } from '../utils/AppError.js';

/**
 * Rejects requests without a valid Supabase access token (`Authorization: Bearer <token>`)
 * and attaches the verified user to `req.auth`.
 * Pass `null` when Supabase is not configured: protected routes then answer 503.
 */
export function requireAuth(verifyAccessToken: VerifyAccessToken | null): RequestHandler {
  return async (req, _res, next) => {
    if (!verifyAccessToken) {
      throw new AppError(503, ErrorCode.ServiceUnavailable, 'Authentication is not configured on the server.');
    }

    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    if (!match?.[1]) {
      throw new AppError(401, ErrorCode.Unauthorized, 'Sign in to continue.');
    }

    req.auth = await verifyAccessToken(match[1]);
    next();
  };
}

/** The verified user of a request that passed requireAuth. */
export function authUser(req: Request): AuthUser {
  if (!req.auth) throw new AppError(401, ErrorCode.Unauthorized, 'Sign in to continue.');
  return req.auth;
}
