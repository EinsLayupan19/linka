import { Router } from 'express';
import {
  createProfileSchema,
  ErrorCode,
  updateProfileSchema,
  USER_SEARCH_LIMIT,
  userSearchQuerySchema,
} from '@linka/shared';
import { authUser, requireAuth } from '../middleware/requireAuth.js';
import type { VerifyAccessToken } from '../services/auth.js';
import type { ProfileStore } from '../services/profiles.js';
import { AppError } from '../utils/AppError.js';
import { parseBody } from '../validation/parseBody.js';

/**
 * /api/users/me: the signed-in user's own profile.
 * /api/users/search: find other users by username.
 * The user ID always comes from the verified access token, never from the request.
 */
export function usersRouter(deps: {
  verifyAccessToken: VerifyAccessToken | null;
  profiles: ProfileStore | null;
}): Router {
  const router = Router();

  router.use(requireAuth(deps.verifyAccessToken));
  router.use((_req, res, next) => {
    // Personal data: never cache in shared caches or the browser.
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  function profiles(): ProfileStore {
    if (!deps.profiles) {
      throw new AppError(503, ErrorCode.ServiceUnavailable, 'The database is not configured on the server.');
    }
    return deps.profiles;
  }

  // Username-based discovery: prefix match, signed-in users only, small result set,
  // public fields only (never email).
  router.get('/search', async (req, res) => {
    const { q } = parseBody(userSearchQuerySchema, req.query);
    const users = await profiles().searchByUsername(q, { excludeUserId: authUser(req).userId, limit: USER_SEARCH_LIMIT });
    res.json({ users });
  });

  // Activity report for "Last seen" (throttled by the server; see markSeen).
  router.post('/me/seen', async (req, res) => {
    await profiles().markSeen(authUser(req).userId);
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    const profile = await profiles().findById(authUser(req).userId);
    if (!profile) throw new AppError(404, ErrorCode.ProfileNotFound, 'You have not set up your profile yet.');
    res.json(profile);
  });

  router.post('/me', async (req, res) => {
    const input = parseBody(createProfileSchema, req.body);
    res.status(201).json(await profiles().create(authUser(req).userId, input));
  });

  router.patch('/me', async (req, res) => {
    const input = parseBody(updateProfileSchema, req.body);
    const profile = await profiles().update(authUser(req).userId, input);
    if (!profile) throw new AppError(404, ErrorCode.ProfileNotFound, 'You have not set up your profile yet.');
    res.json(profile);
  });

  return router;
}
