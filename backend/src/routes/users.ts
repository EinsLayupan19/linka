import { Router } from 'express';
import { createProfileSchema, ErrorCode, updateProfileSchema } from '@linka/shared';
import { authUser, requireAuth } from '../middleware/requireAuth.js';
import type { VerifyAccessToken } from '../services/auth.js';
import type { ProfileStore } from '../services/profiles.js';
import { AppError } from '../utils/AppError.js';
import { parseBody } from '../validation/parseBody.js';

/**
 * /api/users/me: the signed-in user's own profile.
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
