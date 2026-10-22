import { and, eq, inArray, isNull, lt, max, or, sql, type SQL } from 'drizzle-orm';
import {
  ErrorCode,
  type MarkDeliveredInput,
  type MarkDeliveredResult,
  type MarkReadInput,
  type MemberMarkers,
} from '@linka/shared';
import type { Database } from '../db/client.js';
import { conversationMembers, messages } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { conversationNotFound, requireMembership } from './membership.js';

/**
 * Read and delivery markers: two timestamps per member (conversation_members), never a row per
 * message. Every method acts on the caller's own row only; the user id comes from the token.
 * Markers only move forward, and never past the conversation's newest message (so nobody can
 * mark future messages as read in advance).
 */
export interface MarkerStore {
  /** Advances the caller's read marker (and delivery, since read implies delivered). */
  markRead(userId: string, conversationId: string, input: MarkReadInput): Promise<MemberMarkers>;
  /** Advances the caller's delivery markers in several conversations at once. */
  markDelivered(userId: string, input: MarkDeliveredInput): Promise<MarkDeliveredResult>;
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

const aheadOfConversation = (field: string) =>
  new AppError(400, ErrorCode.ValidationFailed, 'This is later than the newest message.', {
    [field]: 'This is later than the newest message.',
  });

export function createMarkerStore(db: Database): MarkerStore {
  /** Newest message time per conversation (one indexed lookup each). */
  async function newestMessageTimes(conversationIds: string[]): Promise<Map<string, Date>> {
    const rows = await db
      .select({ conversationId: messages.conversationId, newest: max(messages.createdAt) })
      .from(messages)
      .where(inArray(messages.conversationId, conversationIds))
      .groupBy(messages.conversationId);
    return new Map(rows.flatMap((r) => (r.newest ? [[r.conversationId, r.newest] as const] : [])));
  }

  function toMarkers(row: { conversationId: string; lastDeliveredAt: Date | null; lastReadAt: Date | null }) {
    return { conversationId: row.conversationId, lastDeliveredAt: iso(row.lastDeliveredAt), lastReadAt: iso(row.lastReadAt) };
  }

  const ownRow = (userId: string, conversationId: string) =>
    and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId));

  return {
    async markRead(userId, conversationId, { lastReadAt }) {
      await requireMembership(db, conversationId, userId);
      const at = new Date(lastReadAt);

      const newest = (await newestMessageTimes([conversationId])).get(conversationId);
      if (!newest || at > newest) throw aheadOfConversation('lastReadAt');

      const returning = {
        conversationId: conversationMembers.conversationId,
        lastDeliveredAt: conversationMembers.lastDeliveredAt,
        lastReadAt: conversationMembers.lastReadAt,
      };

      // Only a forward move writes (an equal marker is a no-op, not a write).
      const [updated] = await db
        .update(conversationMembers)
        .set({
          lastReadAt: at,
          // Read implies delivered: delivery catches up, but never moves back.
          lastDeliveredAt: sql`greatest(coalesce(${conversationMembers.lastDeliveredAt}, ${at}), ${at})`,
        })
        .where(and(ownRow(userId, conversationId), or(isNull(conversationMembers.lastReadAt), lt(conversationMembers.lastReadAt, at))))
        .returning(returning);
      if (updated) return toMarkers(updated);

      const [current] = await db.select(returning).from(conversationMembers).where(ownRow(userId, conversationId)).limit(1);
      if (!current) throw conversationNotFound(); // left in the meantime
      if (current.lastReadAt && current.lastReadAt.getTime() === at.getTime()) return toMarkers(current);
      throw new AppError(409, ErrorCode.MarkerBehind, 'Already read further than this.');
    },

    async markDelivered(userId, { conversations }) {
      // The same conversation twice in one batch: keep the newest time.
      const latest = new Map<string, Date>();
      for (const { conversationId, lastDeliveredAt } of conversations) {
        const at = new Date(lastDeliveredAt);
        const previous = latest.get(conversationId);
        if (!previous || at > previous) latest.set(conversationId, at);
      }
      const ids = [...latest.keys()];

      // All or nothing: one conversation the caller is not in rejects the whole batch.
      const memberships = await db
        .select({ conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(and(eq(conversationMembers.userId, userId), inArray(conversationMembers.conversationId, ids)));
      if (memberships.length !== ids.length) throw conversationNotFound();

      const newest = await newestMessageTimes(ids);
      for (const [conversationId, at] of latest) {
        const limit = newest.get(conversationId);
        if (!limit || at > limit) throw aheadOfConversation('conversations');
      }

      // One statement for the whole batch. Rows already at or past their time are left alone,
      // so a marker never moves backwards and unchanged markers cost no write.
      const targetFor = (column: SQL | typeof conversationMembers.conversationId): SQL =>
        sql`case ${column} ${sql.join(
          ids.map((id) => sql`when ${id}::uuid then ${latest.get(id)!}::timestamptz`),
          sql` `,
        )} end`;

      const updated = await db
        .update(conversationMembers)
        .set({ lastDeliveredAt: targetFor(conversationMembers.conversationId) })
        .where(
          and(
            eq(conversationMembers.userId, userId),
            inArray(conversationMembers.conversationId, ids),
            sql`(${conversationMembers.lastDeliveredAt} is null or ${conversationMembers.lastDeliveredAt} < ${targetFor(conversationMembers.conversationId)})`,
          ),
        )
        .returning({
          conversationId: conversationMembers.conversationId,
          lastDeliveredAt: conversationMembers.lastDeliveredAt,
          lastReadAt: conversationMembers.lastReadAt,
        });

      return { updated: updated.map(toMarkers) };
    },
  };
}
