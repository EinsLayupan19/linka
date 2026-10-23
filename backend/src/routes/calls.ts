import { Router } from 'express';
import { z } from 'zod';
import { createCallSchema, ErrorCode, type IceServer } from '@linka/shared';
import { authUser, requireAuth } from '../middleware/requireAuth.js';
import type { VerifyAccessToken } from '../services/auth.js';
import type { CallStore } from '../services/calls.js';
import { AppError } from '../utils/AppError.js';
import { parseBody } from '../validation/parseBody.js';

const uuid = z.uuid();

/**
 * /api/calls: the call lifecycle (start, answer, decline, hang up) and the ICE servers browsers
 * need to connect. Signaling itself goes browser to browser over the call's private Realtime
 * channel, and the audio over WebRTC; neither passes through the API.
 */
export function callsRouter(deps: {
  verifyAccessToken: VerifyAccessToken | null;
  calls: CallStore | null;
  iceServers: IceServer[];
}): Router {
  const router = Router();

  router.use(requireAuth(deps.verifyAccessToken));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  function store(): CallStore {
    if (!deps.calls) throw new AppError(503, ErrorCode.ServiceUnavailable, 'The database is not configured on the server.');
    return deps.calls;
  }

  // A malformed id can never match a call: answer like any unknown call.
  function callId(value: string | string[] | undefined): string {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw new AppError(404, ErrorCode.NotFound, 'Call not found.');
    return parsed.data;
  }

  router.post('/', async (req, res) => {
    const { conversationId, type } = parseBody(createCallSchema, req.body);
    res.status(201).json(await store().start(authUser(req).userId, conversationId, type));
  });

  router.get('/ongoing', async (req, res) => {
    res.json({ calls: await store().listOngoing(authUser(req).userId) });
  });

  // STUN (and later TURN) servers. Served by the API so TURN credentials can be short-lived and
  // never need to be built into the frontend.
  router.get('/ice-servers', (_req, res) => {
    res.json({ iceServers: deps.iceServers });
  });

  router.get('/:callId', async (req, res) => {
    res.json(await store().getForUser(authUser(req).userId, callId(req.params.callId)));
  });

  router.post('/:callId/accept', async (req, res) => {
    res.json(await store().accept(authUser(req).userId, callId(req.params.callId)));
  });

  router.post('/:callId/decline', async (req, res) => {
    res.json(await store().decline(authUser(req).userId, callId(req.params.callId)));
  });

  router.post('/:callId/end', async (req, res) => {
    res.json(await store().end(authUser(req).userId, callId(req.params.callId)));
  });

  router.post('/:callId/heartbeat', async (req, res) => {
    await store().heartbeat(authUser(req).userId, callId(req.params.callId));
    res.status(204).end();
  });

  return router;
}
