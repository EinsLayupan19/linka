import type { Request, RequestHandler } from 'express';
import { ErrorCode } from '@linka/shared';
import type { AuthUser, VerifyAccessToken } from '../services/auth.js';
import { AppError } from '../utils/AppError.js';
import { clientIp, refuseIfLimited, type RateLimiter } from './rateLimit.js';

/**
 * Rejects requests without a valid Supabase access token (`Authorization: Bearer <token>`)
 * and attaches the verified user to `req.auth`.
 * Pass `null` when Supabase is not configured: protected routes then answer 503.
 * With `unauthenticated`, every request that fails here counts against its IP address, and past
 * the limit it gets 429 instead of 401 (so nobody can hammer the API with made-up tokens).
 */
export function requireAuth(verifyAccessToken: VerifyAccessToken | null, unauthenticated?: RateLimiter): RequestHandler {
  return async (req, res, next) => {
    if (!verifyAccessToken) {
      throw new AppError(503, ErrorCode.ServiceUnavailable, 'Authentication is not configured on the server.');
    }
    const refuse = (error: AppError): never => {
      if (unauthenticated) refuseIfLimited(unauthenticated.hit(clientIp(req)), (name, value) => res.set(name, value));
      throw error;
    };
    const token = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!token) return refuse(new AppError(401, ErrorCode.Unauthorized, 'Sign in to continue.'));
    try {
      req.auth = await verifyAccessToken(token);
    } catch (error) {
      // Only "this token is not acceptable"; a 503 (keys unreachable) is not the client's doing.
      if (error instanceof AppError && error.statusCode === 401) return refuse(error);
      throw error;
    }
    next();
  };
}

/** The verified user of a request that passed requireAuth. */
export function authUser(req: Request): AuthUser {
  if (!req.auth) throw new AppError(401, ErrorCode.Unauthorized, 'Sign in to continue.');
  return req.auth;
}
