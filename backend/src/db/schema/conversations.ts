import { sql } from 'drizzle-orm';
import { check, index, pgPolicy, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { conversationType, memberRole } from './enums.js';
import { profiles } from './profiles.js';
import { isConversationMember } from './rls.js';

/**
 * A chat: either 1:1 ("direct") or a named group. Membership lives in conversation_members.
 *
 * 1:1 uniqueness: a direct conversation stores its two users in a fixed order
 * (low id < high id), and the pair is unique, so the database itself prevents a second
 * 1:1 conversation between the same two people, whatever order they were given in.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: conversationType('type').notNull(),
    /** Groups only. */
    name: text('name'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    /** Direct only: the two members, ordered. Null for groups. */
    directLowUserId: uuid('direct_low_user_id').references(() => profiles.id, { onDelete: 'set null' }),
    directHighUserId: uuid('direct_high_user_id').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('conversations_direct_pair_unique').on(table.directLowUserId, table.directHighUserId),
    // A pair is stored low-first, so (A, B) and (B, A) are the same row.
    check('conversations_direct_pair_order', sql`${table.directLowUserId} < ${table.directHighUserId}`),
    check(
      'conversations_direct_shape',
      sql`${table.type} = 'direct' or (${table.directLowUserId} is null and ${table.directHighUserId} is null)`,
    ),
    // "is not null" is explicit: a CHECK that evaluates to NULL counts as passing.
    check(
      'conversations_name_shape',
      sql`(${table.type} = 'group' and ${table.name} is not null and char_length(${table.name}) <= 100 and btrim(${table.name}) <> '')
        or (${table.type} = 'direct' and ${table.name} is null)`,
    ),
    pgPolicy('conversations_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: isConversationMember(table.id),
    }),
  ],
).enableRLS();

/**
 * Who is in a conversation, with their role. The primary key prevents duplicate membership.
 * last_delivered_at / last_read_at are per-member markers filled in by the read/delivery phase.
 */
export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true, precision: 3 }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({ name: 'conversation_members_pkey', columns: [table.conversationId, table.userId] }),
    // "My conversations": the primary key starts with conversation_id, so user_id needs its own index.
    index('conversation_members_user_id_idx').on(table.userId),
    // At most one owner per conversation.
    uniqueIndex('conversation_members_one_owner_idx')
      .on(table.conversationId)
      .where(sql`${table.role} = 'owner'`),
    // Members can see who else is in their conversations (not other conversations).
    pgPolicy('conversation_members_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: isConversationMember(table.conversationId),
    }),
  ],
).enableRLS();

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationMemberRow = typeof conversationMembers.$inferSelect;
