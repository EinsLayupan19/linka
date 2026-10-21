import { and, eq } from 'drizzle-orm';
import { ErrorCode, type ConversationType, type MemberRole } from '@linka/shared';
import type { Database } from '../db/client.js';
import { conversationMembers, conversations } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';

export interface Membership {
  role: MemberRole;
  conversationType: ConversationType;
}

/** The user's membership in a conversation, or null if they are not a member (or it does not exist). */
export async function findMembership(db: Database, conversationId: string, userId: string): Promise<Membership | null> {
  const [row] = await db
    .select({ role: conversationMembers.role, conversationType: conversations.type })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export const conversationNotFound = () =>
  new AppError(404, ErrorCode.ConversationNotFound, 'Conversation not found.');

/**
 * The central authorization check for anything inside a conversation.
 * Non-members get the same 404 as for a conversation that does not exist,
 * so the API never reveals which conversations exist.
 */
export async function requireMembership(db: Database, conversationId: string, userId: string): Promise<Membership> {
  const membership = await findMembership(db, conversationId, userId);
  if (!membership) throw conversationNotFound();
  return membership;
}
