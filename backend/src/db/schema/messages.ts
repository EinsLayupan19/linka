import { sql } from 'drizzle-orm';
import { bigint, check, index, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { conversations } from './conversations.js';
import { messageType } from './enums.js';
import { profiles } from './profiles.js';
import { isConversationMember } from './rls.js';

/**
 * Messages belong to a conversation. Pages are read newest-first with the cursor
 * (created_at, id): the id breaks ties between messages with the same timestamp.
 *
 * `type` allows new kinds of messages later; `text` messages must have content.
 * The sender is kept as null if their account is deleted, so the conversation history
 * stays intact for the other members.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').references(() => profiles.id, { onDelete: 'set null' }),
    type: messageType('type').notNull().default('text'),
    content: text('content'),
    /**
     * Millisecond precision on purpose: it is exactly what JavaScript dates, the API and
     * pagination cursors carry, so a cursor never sits a few microseconds off a row.
     */
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** The sender's idempotency key: a retried send with the same key finds this row. */
    clientId: uuid('client_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Soft delete: the row stays so pagination cursors and replies keep working. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // Message history and cursor pagination. Postgres reads it in either direction,
    // and it also serves plain "WHERE conversation_id = ?" lookups.
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt, table.id),
    // Keeps "ON DELETE SET NULL" fast when a user is deleted, and "messages by user" lookups.
    index('messages_sender_id_idx').on(table.senderId),
    // Retries cannot create duplicates: one message per (sender, clientId).
    uniqueIndex('messages_sender_client_id_idx')
      .on(table.senderId, table.clientId)
      .where(sql`${table.clientId} is not null`),
    // "is not null" is explicit: a CHECK that evaluates to NULL counts as passing.
    check(
      'messages_text_content',
      sql`${table.type} <> 'text' or (${table.content} is not null and char_length(${table.content}) <= 4000 and btrim(${table.content}) <> '')`,
    ),
    pgPolicy('messages_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: isConversationMember(table.conversationId),
    }),
  ],
).enableRLS();

/**
 * Files attached to a message. Database foundation only: uploads to Supabase Storage
 * arrive with media sharing. storage_path is unique so two rows never point at one file.
 */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    storagePath: text('storage_path').notNull().unique('message_attachments_storage_path_unique'),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Load the attachments of a page of messages.
    index('message_attachments_message_id_idx').on(table.messageId),
    check('message_attachments_size_positive', sql`${table.sizeBytes} > 0`),
    check(
      'message_attachments_file_name_length',
      sql`char_length(${table.fileName}) between 1 and 255`,
    ),
    // Visible to members of the conversation the message belongs to.
    pgPolicy('message_attachments_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: sql`exists (
        select 1 from public.messages m
        where m.id = ${table.messageId} and ${isConversationMember(sql`m.conversation_id`)}
      )`,
    }),
  ],
).enableRLS();

export type MessageRow = typeof messages.$inferSelect;
export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
