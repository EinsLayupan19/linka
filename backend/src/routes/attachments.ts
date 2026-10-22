import { Router } from 'express';
import { z } from 'zod';
import { attachmentUrlsRequestSchema, ErrorCode } from '@linka/shared';
import { authUser, requireAuth } from '../middleware/requireAuth.js';
import type { AttachmentStore } from '../services/attachments.js';
import type { VerifyAccessToken } from '../services/auth.js';
import { AppError } from '../utils/AppError.js';
import { parseBody } from '../validation/parseBody.js';

const uuid = z.uuid();

/**
 * /api/attachments: finishing, cancelling and viewing uploads. Every action is limited to what
 * the signed-in user may do (their own uploads; attachments in their conversations).
 */
export function attachmentsRouter(deps: {
  verifyAccessToken: VerifyAccessToken | null;
  attachments: AttachmentStore | null;
}): Router {
  const router = Router();

  router.use(requireAuth(deps.verifyAccessToken));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  function store(): AttachmentStore {
    if (!deps.attachments) {
      throw new AppError(503, ErrorCode.ServiceUnavailable, 'The database is not configured on the server.');
    }
    return deps.attachments;
  }

  // A malformed id can never match an attachment: answer like any unknown attachment.
  function attachmentId(value: string | string[] | undefined): string {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw new AppError(404, ErrorCode.AttachmentNotFound, 'Attachment not found.');
    return parsed.data;
  }

  // Short-lived download URLs for attachments the caller may see.
  router.post('/urls', async (req, res) => {
    const { attachmentIds } = parseBody(attachmentUrlsRequestSchema, req.body);
    res.json(await store().signedUrls(authUser(req).userId, attachmentIds));
  });

  // The browser finished uploading: check the stored file and mark it ready.
  router.post('/:attachmentId/complete', async (req, res) => {
    res.json(await store().complete(authUser(req).userId, attachmentId(req.params.attachmentId)));
  });

  // Cancel an upload that has not been sent (deletes the file too).
  router.delete('/:attachmentId', async (req, res) => {
    await store().cancel(authUser(req).userId, attachmentId(req.params.attachmentId));
    res.status(204).end();
  });

  return router;
}
