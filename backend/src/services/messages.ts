import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ErrorCode,
  type Attachment,
  type CreateMessageInput,
  type Message,
  type MessagePage,
  type MessagePageQuery,
} from '@linka/shared';
import type { Database } from '../db/client.js';
import { conversations, messageAttachments, messages, type MessageRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { requireMembership } from './membership.js';

export function toMessage(row: MessageRow, attachments: Attachment[] = []): Message {
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
    attachments,
  };
}

/** Attachment metadata for many messages in one query (oldest first per message). No paths. */
export async function loadAttachments(db: Database, messageIds: string[]): Promise<Map<string, Attachment[]>> {
  const byMessage = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      id: messageAttachments.id,
      fileName: messageAttachments.fileName,
      contentType: messageAttachments.contentType,
      sizeBytes: messageAttachments.sizeBytes,
    })
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, messageIds))
    .orderBy(asc(messageAttachments.createdAt), asc(messageAttachments.id));
  for (const { messageId, ...attachment } of rows) {
    if (!messageId) continue;
    const list = byMessage.get(messageId) ?? [];
    list.push({ ...attachment, contentType: attachment.contentType as Attachment['contentType'] });
    byMessage.set(messageId, list);
  }
  return byMessage;
}

export interface MessageStore {
  /**
   * A page of history, oldest first. Without a cursor: the newest messages.
   * With `before`: the messages just older than that cursor.
   */
  list(userId: string, conversationId: string, query: MessagePageQuery): Promise<MessagePage>;
  /**
   * Stores a message from `userId`, who must be a member. Attachments must be the caller's own
   * finished (`ready`), unsent uploads in this conversation. Sending again with the same
   * clientId returns the original message (created: false) instead of a duplicate.
   */
  create(userId: string, conversationId: string, input: CreateMessageInput): Promise<{ message: Message; created: boolean }>;
}

const unusableAttachments = () =>
  new AppError(400, ErrorCode.ValidationFailed, 'Some attachments cannot be sent.', {
    attachmentIds: 'Attachments must be your own finished uploads in this conversation, not sent before.',
  });

export function createMessageStore(db: Database): MessageStore {
  async function findByClientId(userId: string, clientId: string) {
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, userId), eq(messages.clientId, clientId)))
      .limit(1);
    return row;
  }

  async function withAttachments(row: MessageRow): Promise<Message> {
    const attachments = await loadAttachments(db, [row.id]);
    return toMessage(row, attachments.get(row.id) ?? []);
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
      const pageRows = rows.slice(0, limit).reverse();
      const attachments = await loadAttachments(db, pageRows.map((r) => r.id));
      const page = pageRows.map((row) => toMessage(row, attachments.get(row.id) ?? []));
      const oldest = page[0];
      return { messages: page, nextCursor: hasOlder && oldest ? encodeCursor(oldest) : null };
    },

    async create(userId, conversationId, input) {
      await requireMembership(db, conversationId, userId);
      const attachmentIds = input.attachmentIds ?? [];

      // A retry of a message that already arrived: hand back the original.
      const previous = await findByClientId(userId, input.clientId);
      if (previous) return reuse(previous);

      try {
        const row = await db.transaction(async (tx) => {
          if (attachmentIds.length > 0) {
            // Lock the uploads so a concurrent send, cancel or sweep cannot take them too.
            const usable = await tx
              .select({ id: messageAttachments.id })
              .from(messageAttachments)
              .where(
                and(
                  inArray(messageAttachments.id, attachmentIds),
                  eq(messageAttachments.uploaderId, userId),
                  eq(messageAttachments.conversationId, conversationId),
                  eq(messageAttachments.status, 'ready'),
                  isNull(messageAttachments.messageId),
                ),
              )
              .for('update');
            if (usable.length !== attachmentIds.length) throw unusableAttachments();
          }

          const [inserted] = await tx
            .insert(messages)
            // The sender is the authenticated user, never a value from the request.
            .values({
              conversationId,
              senderId: userId,
              clientId: input.clientId,
              type: attachmentIds.length > 0 ? 'attachment' : 'text',
              content: input.content ?? null,
            })
            .returning();
          if (!inserted) throw new Error('Insert returned no row');

          if (attachmentIds.length > 0) {
            await tx
              .update(messageAttachments)
              .set({ messageId: inserted.id })
              .where(inArray(messageAttachments.id, attachmentIds));
          }
          // The conversation's last activity, used to sort conversation lists.
          await tx.update(conversations).set({ updatedAt: inserted.createdAt }).where(eq(conversations.id, conversationId));
          // The realtime triggers are deferred: they run at commit, with the attachments linked.
          return inserted;
        });
        return { message: await withAttachments(row), created: true };
      } catch (error) {
        if (error instanceof AppError) throw error;
        // The same retry raced the first attempt; the unique (sender, clientId) index decided.
        const winner = await findByClientId(userId, input.clientId);
        if (winner) return reuse(winner);
        throw error;
      }

      async function reuse(row: MessageRow) {
        if (row.conversationId !== conversationId) {
          throw new AppError(409, ErrorCode.BadRequest, 'This client id was already used for another message.');
        }
        return { message: await withAttachments(row), created: false };
      }
    },
  };
}
