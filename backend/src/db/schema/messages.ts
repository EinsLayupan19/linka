import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgPolicy, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ATTACHMENT_CONTENT_TYPES, MAX_FILE_BYTES } from '@linka/shared';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { conversations } from './conversations.js';
import { attachmentStatus, messageType } from './enums.js';
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
    // Captions of attachment messages are optional but bounded like text.
    check('messages_content_length', sql`${table.content} is null or char_length(${table.content}) <= 4000`),
    // Lets attachments reference (message, conversation) together, so an attachment can never be
    // linked to a message in a different conversation.
    unique('messages_id_conversation_unique').on(table.id, table.conversationId),
    pgPolicy('messages_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: isConversationMember(table.conversationId),
    }),
  ],
).enableRLS();

const allowedContentTypes = sql.raw(ATTACHMENT_CONTENT_TYPES.map((type) => `'${type}'`).join(', '));

/**
 * Files attached to messages. Only metadata lives here; the bytes live in the private
 * `attachments` Storage bucket at storage_path = <conversation_id>/<uploader_id>/<id>.<ext>.
 *
 * Lifecycle: a row is created `pending` when an upload starts (message_id null), becomes
 * `ready` once the server has verified the uploaded object, and is attached when a message is
 * sent with it. Unattached rows older than UNATTACHED_UPLOAD_TTL_HOURS are swept, file first.
 */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Null until the attachment is sent in a message. */
    messageId: uuid('message_id'),
    /** Null if the uploader's account was deleted. */
    uploaderId: uuid('uploader_id').references(() => profiles.id, { onDelete: 'set null' }),
    /** The uploader's idempotency key: starting the same upload again finds this row. */
    clientId: uuid('client_id').notNull(),
    status: attachmentStatus('status').notNull().default('pending'),
    storagePath: text('storage_path').notNull().unique('message_attachments_storage_path_unique'),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // An attachment belongs to a message in its own conversation, never another one.
    foreignKey({
      name: 'message_attachments_message_fk',
      columns: [table.messageId, table.conversationId],
      foreignColumns: [messages.id, messages.conversationId],
    }).onDelete('cascade'),
    // Load the attachments of a page of messages.
    index('message_attachments_message_id_idx').on(table.messageId),
    // Retried upload starts find the same row.
    uniqueIndex('message_attachments_uploader_client_idx').on(table.uploaderId, table.clientId),
    // The cleanup sweep: unattached uploads by age.
    index('message_attachments_unattached_idx').on(table.createdAt).where(sql`${table.messageId} is null`),
    check('message_attachments_size_positive', sql`${table.sizeBytes} > 0`),
    check('message_attachments_size_limit', sql`${table.sizeBytes} <= ${sql.raw(String(MAX_FILE_BYTES))}`),
    check('message_attachments_file_name_length', sql`char_length(${table.fileName}) between 1 and 255`),
    check('message_attachments_content_type', sql`${table.contentType} in (${allowedContentTypes})`),
    // Only verified uploads can be part of a message.
    check('message_attachments_attached_ready', sql`${table.messageId} is null or ${table.status} = 'ready'`),
    // The path always lives under this row's own conversation and id.
    check(
      'message_attachments_path_shape',
      sql`${table.storagePath} = ${table.conversationId}::text || '/' || split_part(${table.storagePath}, '/', 2) || '/' || ${table.id}::text || '.' || split_part(split_part(${table.storagePath}, '/', 3), '.', 2)
        and split_part(${table.storagePath}, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and split_part(split_part(${table.storagePath}, '/', 3), '.', 2) ~ '^[a-z0-9]{1,5}$'
        and (${table.uploaderId} is null or split_part(${table.storagePath}, '/', 2) = ${table.uploaderId}::text)`,
    ),
    // Members see attached files; an uploader also sees their own unsent uploads.
    pgPolicy('message_attachments_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${isConversationMember(table.conversationId)}
        and (${table.messageId} is not null or ${table.uploaderId} = (select auth.uid()))`,
    }),
  ],
).enableRLS();

export type MessageRow = typeof messages.$inferSelect;
export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
