import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * RLS condition: the current user (auth.uid()) is a member of the given conversation.
 * The function is created in migration 0001_rls_helpers.sql.
 */
export const isConversationMember = (conversationId: AnyPgColumn | SQL): SQL =>
  sql`private.is_conversation_member(${conversationId})`;
