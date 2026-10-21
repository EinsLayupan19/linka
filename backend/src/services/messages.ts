import type { CreateMessageInput, Message } from '@linka/shared';
import type { Database } from '../db/client.js';
import { messages, type MessageRow } from '../db/schema/index.js';
import { requireMembership } from './membership.js';

// Persistence foundation for messages. Sending over the API, pagination and realtime
// delivery are built on top of this in the messaging phase.

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.type,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export interface MessageStore {
  /** Stores a text message from `userId`, who must be a member of the conversation. */
  create(userId: string, conversationId: string, input: CreateMessageInput): Promise<Message>;
}

export function createMessageStore(db: Database): MessageStore {
  return {
    async create(userId, conversationId, input) {
      await requireMembership(db, conversationId, userId);

      const [row] = await db
        .insert(messages)
        // The sender is the authenticated user, never a value from the request.
        .values({ conversationId, senderId: userId, type: 'text', content: input.content })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      return toMessage(row);
    },
  };
}
