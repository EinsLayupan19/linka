import { and, desc, eq, sql } from 'drizzle-orm';
import { ErrorCode, type CreateMessageInput, type Message, type MessagePage, type MessagePageQuery } from '@linka/shared';
import type { Database } from '../db/client.js';
import { conversations, messages, type MessageRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { requireMembership } from './membership.js';

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    clientId: row.clientId,
    type: row.type,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export interface MessageStore {
  /**
   * A page of history, oldest first. Without a cursor: the newest messages.
   * With `before`: the messages just older than that cursor.
   */
  list(userId: string, conversationId: string, query: MessagePageQuery): Promise<MessagePage>;
  /**
   * Stores a text message from `userId`, who must be a member. Sending again with the same
   * clientId returns the original message (created: false) instead of a duplicate.
   */
  create(userId: string, conversationId: string, input: CreateMessageInput): Promise<{ message: Message; created: boolean }>;
}

export function createMessageStore(db: Database): MessageStore {
  async function findByClientId(userId: string, clientId: string) {
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, userId), eq(messages.clientId, clientId)))
      .limit(1);
    return row;
  }

  return {
    async list(userId, conversationId, { limit, before }) {
      await requireMembership(db, conversationId, userId);
      const cursor = before ? decodeCursor(before) : null;

      // Newest first, one extra row to learn whether an older page exists.
      // Row-value comparison keeps ties on created_at stable, and both parts walk the
      // (conversation_id, created_at, id) index backwards.
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            cursor ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}, ${cursor.id})` : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const hasOlder = rows.length > limit;
      const page = rows.slice(0, limit).reverse().map(toMessage);
      const oldest = page[0];
      return { messages: page, nextCursor: hasOlder && oldest ? encodeCursor(oldest) : null };
    },

    async create(userId, conversationId, input) {
      await requireMembership(db, conversationId, userId);

      // A retry of a message that already arrived: hand back the original.
      const previous = await findByClientId(userId, input.clientId);
      if (previous) return reuse(previous);

      try {
        const row = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(messages)
            // The sender is the authenticated user, never a value from the request.
            .values({ conversationId, senderId: userId, clientId: input.clientId, type: 'text', content: input.content })
            .returning();
          if (!inserted) throw new Error('Insert returned no row');
          // The conversation's last activity, used to sort conversation lists.
          await tx
            .update(conversations)
            .set({ updatedAt: inserted.createdAt })
            .where(eq(conversations.id, conversationId));
          return inserted;
        });
        return { message: toMessage(row), created: true };
      } catch (error) {
        // The same retry raced the first attempt; the unique (sender, clientId) index decided.
        const winner = await findByClientId(userId, input.clientId);
        if (winner) return reuse(winner);
        throw error;
      }

      function reuse(row: MessageRow) {
        if (row.conversationId !== conversationId) {
          throw new AppError(409, ErrorCode.BadRequest, 'This client id was already used for another message.');
        }
        return { message: toMessage(row), created: false };
      }
    },
  };
}
