import { sql } from 'drizzle-orm';
import { check, index, pgPolicy, pgTable, primaryKey, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { conversations } from './conversations.js';
import { callStatus, callType } from './enums.js';
import { profiles } from './profiles.js';
import { isConversationMember } from './rls.js';

/**
 * A voice or video call inside a conversation. The API owns the lifecycle (ringing -> active ->
 * ended, or missed / declined); the media itself flows browser to browser over WebRTC and never
 * touches the database or the API.
 */
export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    initiatorId: uuid('initiator_id').references(() => profiles.id, { onDelete: 'set null' }),
    type: callType('type').notNull(),
    status: callStatus('status').notNull().default('ringing'),
    /** When the call was answered. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last "still here" from a connected participant; an active call silent for too long is ended. */
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Call history of a conversation, newest first.
    index('calls_conversation_created_idx').on(table.conversationId, table.createdAt),
    // At most one ringing or active call per conversation.
    uniqueIndex('calls_one_ongoing_per_conversation_idx')
      .on(table.conversationId)
      .where(sql`${table.status} in ('ringing', 'active')`),
    // The stale-call sweep: only ringing and active calls.
    index('calls_ongoing_idx')
      .on(table.status)
      .where(sql`${table.status} in ('ringing', 'active')`),
    check('calls_end_after_start', sql`${table.endedAt} is null or ${table.startedAt} is null or ${table.endedAt} >= ${table.startedAt}`),
    pgPolicy('calls_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: isConversationMember(table.conversationId),
    }),
  ],
).enableRLS();

/** Who takes part in a call. joined_at is null while the call is still ringing for them. */
export const callParticipants = pgTable(
  'call_participants',
  {
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ name: 'call_participants_pkey', columns: [table.callId, table.userId] }),
    // A user's calls; also keeps ON DELETE CASCADE from profiles fast.
    index('call_participants_user_id_idx').on(table.userId),
    check(
      'call_participants_leave_after_join',
      sql`${table.leftAt} is null or (${table.joinedAt} is not null and ${table.leftAt} >= ${table.joinedAt})`,
    ),
    pgPolicy('call_participants_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: sql`exists (
        select 1 from public.calls c
        where c.id = ${table.callId} and ${isConversationMember(sql`c.conversation_id`)}
      )`,
    }),
  ],
).enableRLS();

export type CallRow = typeof calls.$inferSelect;
export type CallParticipantRow = typeof callParticipants.$inferSelect;
