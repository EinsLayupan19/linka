import { Router } from 'express';
import { z } from 'zod';
import {
  addMembersSchema,
  createConversationSchema,
  ErrorCode,
  updateConversationSchema,
  updateMemberRoleSchema,
} from '@linka/shared';
import { authUser, requireAuth } from '../middleware/requireAuth.js';
import type { VerifyAccessToken } from '../services/auth.js';
import type { ConversationStore } from '../services/conversations.js';
import { conversationNotFound } from '../services/membership.js';
import { AppError } from '../utils/AppError.js';
import { parseBody } from '../validation/parseBody.js';

const uuid = z.uuid();

/**
 * /api/conversations. Every route requires a signed-in user, and every action is
 * authorized against that user's membership and role in the service layer.
 */
export function conversationsRouter(deps: {
  verifyAccessToken: VerifyAccessToken | null;
  conversations: ConversationStore | null;
}): Router {
  const router = Router();

  router.use(requireAuth(deps.verifyAccessToken));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  function store(): ConversationStore {
    if (!deps.conversations) {
      throw new AppError(503, ErrorCode.ServiceUnavailable, 'The database is not configured on the server.');
    }
    return deps.conversations;
  }

  // A malformed id can never match a conversation: answer like any unknown conversation.
  function conversationId(value: string | string[] | undefined): string {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw conversationNotFound();
    return parsed.data;
  }

  function memberId(value: string | string[] | undefined): string {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw new AppError(404, ErrorCode.MemberNotFound, 'That person is not in this conversation.');
    return parsed.data;
  }

  router.get('/', async (req, res) => {
    res.json({ conversations: await store().listForUser(authUser(req).userId) });
  });

  router.post('/', async (req, res) => {
    const input = parseBody(createConversationSchema, req.body);
    const { conversation, created } = await store().create(authUser(req).userId, input);
    // 200 with the existing conversation when a 1:1 conversation already exists.
    res.status(created ? 201 : 200).json(conversation);
  });

  router.get('/:conversationId', async (req, res) => {
    res.json(await store().getForUser(authUser(req).userId, conversationId(req.params.conversationId)));
  });

  router.patch('/:conversationId', async (req, res) => {
    const input = parseBody(updateConversationSchema, req.body);
    res.json(await store().rename(authUser(req).userId, conversationId(req.params.conversationId), input));
  });

  router.post('/:conversationId/members', async (req, res) => {
    const input = parseBody(addMembersSchema, req.body);
    res.json(await store().addMembers(authUser(req).userId, conversationId(req.params.conversationId), input));
  });

  router.patch('/:conversationId/members/:userId', async (req, res) => {
    const { role } = parseBody(updateMemberRoleSchema, req.body);
    const id = conversationId(req.params.conversationId);
    res.json(await store().updateMemberRole(authUser(req).userId, id, memberId(req.params.userId), role));
  });

  // Remove a member, or leave the group when :userId is yourself.
  router.delete('/:conversationId/members/:userId', async (req, res) => {
    const id = conversationId(req.params.conversationId);
    await store().removeMember(authUser(req).userId, id, memberId(req.params.userId));
    res.status(204).end();
  });

  return router;
}
