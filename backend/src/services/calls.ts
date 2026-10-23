import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  CALL_RING_EXPIRY_SECONDS,
  CALL_STALE_SECONDS,
  ErrorCode,
  ONGOING_CALL_STATUSES,
  type Call,
  type CallType,
} from '@linka/shared';
import type { Database } from '../db/client.js';
import { postgresErrorCode, UNIQUE_VIOLATION } from '../db/errors.js';
import { callParticipants, calls, conversationMembers, type CallRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { findMembership, requireMembership } from './membership.js';

/**
 * The call lifecycle. The API is the only writer, so every transition is checked here:
 *
 *   ringing --accept (callee)--> active --end (either)--> ended
 *   ringing --decline (callee) / end (callee)--> declined
 *   ringing --end (caller) / ring timeout--> missed
 *   active  --no heartbeat for CALL_STALE_SECONDS--> ended
 *
 * Transitions are conditional updates (`WHERE status = ...`), so two racing requests (accept vs.
 * cancel, two tabs answering) resolve to exactly one outcome. Repeating a transition that already
 * happened returns the call unchanged, so clients can retry safely. Every timestamp comes from the
 * database clock (`now()`), so they never disagree with each other.
 *
 * The audio itself never touches the API: it flows browser to browser over WebRTC.
 */
export interface CallStore {
  /** Starts a ringing 1:1 call: the caller has joined, the other member is rung. */
  start(userId: string, conversationId: string, type: CallType): Promise<Call>;
  /** A call the user may see because they belong to its conversation. */
  getForUser(userId: string, callId: string): Promise<Call>;
  /** The user's ringing or active calls (after a reload, or events missed while offline). */
  listOngoing(userId: string): Promise<Call[]>;
  accept(userId: string, callId: string): Promise<Call>;
  decline(userId: string, callId: string): Promise<Call>;
  /** Hang up (active), cancel (caller, ringing) or refuse (callee, ringing). */
  end(userId: string, callId: string): Promise<Call>;
  /** "Still in the call": keeps an active call from being ended as stale. */
  heartbeat(userId: string, callId: string): Promise<void>;
  /** Marks unanswered calls missed and silent active calls ended. Returns how many changed. */
  expireStale(): Promise<number>;
}

const callNotFound = () => new AppError(404, ErrorCode.NotFound, 'Call not found.');

const endedMessage: Record<string, string> = {
  active: 'This call was already answered.',
  ended: 'This call has ended.',
  missed: 'This call is no longer ringing.',
  declined: 'This call was declined.',
};
const callEnded = (status: string) => new AppError(409, ErrorCode.CallEnded, endedMessage[status] ?? 'This call has ended.');

const ongoing = inArray(calls.status, [...ONGOING_CALL_STATUSES]);
const now = sql`now()`;

export function createCallStore(db: Database): CallStore {
  async function load(callId: string): Promise<Call | null> {
    const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    if (!call) return null;
    const participants = await db
      .select()
      .from(callParticipants)
      .where(eq(callParticipants.callId, callId))
      // Same order as the realtime payload (private.call_json).
      .orderBy(asc(callParticipants.userId));
    return toCall(call, participants);
  }

  /** The call, if the user takes part in it and still belongs to its conversation. */
  async function loadForParticipant(userId: string, callId: string): Promise<Call> {
    const call = await load(callId);
    if (!call || !call.participants.some((p) => p.userId === userId)) throw callNotFound();
    if (!(await findMembership(db, call.conversationId, userId))) throw callNotFound();
    return call;
  }

  /** Whether the user is already ringing or connected in another call. */
  async function isBusy(userId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: calls.id })
      .from(calls)
      .innerJoin(callParticipants, eq(callParticipants.callId, calls.id))
      .where(and(eq(callParticipants.userId, userId), ongoing, isNull(callParticipants.leftAt)))
      .limit(1);
    return Boolean(row);
  }

  async function expireStale(): Promise<number> {
    return db.transaction(async (tx) => {
      const expired = await tx
        .update(calls)
        .set({
          status: sql`case when ${calls.status} = 'ringing' then 'missed'::call_status else 'ended'::call_status end`,
          endedAt: now,
        })
        .where(
          or(
            and(eq(calls.status, 'ringing'), sql`${calls.createdAt} < now() - make_interval(secs => ${CALL_RING_EXPIRY_SECONDS})`),
            and(eq(calls.status, 'active'), sql`${calls.lastHeartbeatAt} < now() - make_interval(secs => ${CALL_STALE_SECONDS})`),
          ),
        )
        .returning({ id: calls.id });
      if (expired.length > 0) await leaveAll(tx, expired.map((c) => c.id));
      return expired.length;
    });
  }

  /** Everyone still in these calls leaves now. */
  async function leaveAll(tx: Pick<Database, 'update'>, callIds: string[]) {
    await tx
      .update(callParticipants)
      .set({ leftAt: now })
      .where(and(inArray(callParticipants.callId, callIds), isNotNull(callParticipants.joinedAt), isNull(callParticipants.leftAt)));
  }

  /** Applies a transition only if the call is still in `from`; returns whether it did. */
  async function transition(
    callId: string,
    from: (typeof ONGOING_CALL_STATUSES)[number],
    to: Partial<Pick<CallRow, 'status'>> & Record<string, unknown>,
    after?: (tx: Database) => Promise<void>,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [changed] = await tx
        .update(calls)
        .set(to)
        .where(and(eq(calls.id, callId), eq(calls.status, from)))
        .returning({ id: calls.id });
      if (!changed) return false;
      await after?.(tx as unknown as Database);
      return true;
    });
  }

  async function reload(callId: string): Promise<Call> {
    const call = await load(callId);
    if (!call) throw callNotFound();
    return call;
  }

  return {
    async start(userId, conversationId, type) {
      const membership = await requireMembership(db, conversationId, userId);
      if (membership.conversationType !== 'direct') {
        throw new AppError(400, ErrorCode.CallNotSupported, 'Group calls are not available yet.');
      }
      const [other] = await db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, conversationId), ne(conversationMembers.userId, userId)))
        .limit(1);
      if (!other) throw new AppError(400, ErrorCode.CallNotSupported, 'There is nobody to call in this conversation.');

      // Calls left behind (closed tabs, lost connections) must not block new ones.
      await expireStale();
      // Both calling each other at once: the second one learns about the first (and is rung by it).
      const [current] = await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.conversationId, conversationId), ongoing))
        .limit(1);
      if (current) throw new AppError(409, ErrorCode.CallInProgress, 'There is already a call in this conversation.');
      if (await isBusy(userId)) throw new AppError(409, ErrorCode.UserBusy, 'You are already in a call.');
      if (await isBusy(other.userId)) throw new AppError(409, ErrorCode.UserBusy, 'They are on another call. Try again later.');

      try {
        const callId = await db.transaction(async (tx) => {
          const [call] = await tx.insert(calls).values({ conversationId, initiatorId: userId, type }).returning({ id: calls.id });
          if (!call) throw new Error('Insert returned no row');
          // Participants come from the membership table, so only members can ever be in a call.
          await tx.insert(callParticipants).values([
            { callId: call.id, userId, joinedAt: now },
            { callId: call.id, userId: other.userId, joinedAt: null },
          ]);
          return call.id;
        });
        return reload(callId);
      } catch (error) {
        if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
          throw new AppError(409, ErrorCode.CallInProgress, 'There is already a call in this conversation.');
        }
        throw error;
      }
    },

    async getForUser(userId, callId) {
      const call = await load(callId);
      // Same answer for "does not exist" and "not yours".
      if (!call || !(await findMembership(db, call.conversationId, userId))) throw callNotFound();
      return call;
    },

    async listOngoing(userId) {
      await expireStale();
      const rows = await db
        .select({ id: calls.id })
        .from(calls)
        .innerJoin(callParticipants, eq(callParticipants.callId, calls.id))
        .innerJoin(
          conversationMembers,
          and(eq(conversationMembers.conversationId, calls.conversationId), eq(conversationMembers.userId, userId)),
        )
        .where(and(eq(callParticipants.userId, userId), ongoing, isNull(callParticipants.leftAt)))
        .orderBy(asc(calls.createdAt));
      const loaded = await Promise.all(rows.map((r) => load(r.id)));
      return loaded.filter((c): c is Call => c !== null);
    },

    async accept(userId, callId) {
      await expireStale();
      const call = await loadForParticipant(userId, callId);
      const me = call.participants.find((p) => p.userId === userId)!;
      if (call.initiatorId === userId) throw new AppError(403, ErrorCode.Forbidden, 'You cannot answer your own call.');
      if (call.status === 'active' && me.joinedAt) return call; // answered already (a retry)
      if (call.status !== 'ringing') throw callEnded(call.status);
      if (await isBusyElsewhere(userId, callId)) throw new AppError(409, ErrorCode.UserBusy, 'End your current call first.');

      const accepted = await transition(callId, 'ringing', { status: 'active', startedAt: now, lastHeartbeatAt: now }, async (tx) => {
        await tx
          .update(callParticipants)
          .set({ joinedAt: now })
          .where(and(eq(callParticipants.callId, callId), eq(callParticipants.userId, userId)));
      });
      const current = await reload(callId);
      if (!accepted && !(current.status === 'active' && current.participants.find((p) => p.userId === userId)?.joinedAt)) {
        throw callEnded(current.status); // cancelled or timed out a moment earlier
      }
      return current;
    },

    async decline(userId, callId) {
      const call = await loadForParticipant(userId, callId);
      if (call.initiatorId === userId) throw new AppError(403, ErrorCode.Forbidden, 'Use end to cancel your own call.');
      if (call.status === 'declined') return call;
      if (call.status !== 'ringing') throw callEnded(call.status);
      const declined = await transition(callId, 'ringing', { status: 'declined', endedAt: now });
      const current = await reload(callId);
      if (!declined && current.status !== 'declined') throw callEnded(current.status);
      return current;
    },

    async end(userId, callId) {
      const call = await loadForParticipant(userId, callId);
      if (call.status === 'ringing') {
        // The caller cancelling is a missed call for the other person; the callee hanging up refuses it.
        const status = call.initiatorId === userId ? 'missed' : 'declined';
        await transition(callId, 'ringing', { status, endedAt: now }, (tx) => leaveAll(tx, [callId]));
      } else if (call.status === 'active') {
        await transition(callId, 'active', { status: 'ended', endedAt: now }, (tx) => leaveAll(tx, [callId]));
      }
      // Already over (or it changed state just now): the call as it is, so retries succeed.
      return reload(callId);
    },

    async heartbeat(userId, callId) {
      const call = await loadForParticipant(userId, callId);
      if (call.status !== 'ringing' && call.status !== 'active') throw callEnded(call.status);
      await db
        .update(calls)
        .set({ lastHeartbeatAt: now })
        .where(and(eq(calls.id, callId), ongoing));
    },

    expireStale,
  };

  async function isBusyElsewhere(userId: string, callId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: calls.id })
      .from(calls)
      .innerJoin(callParticipants, eq(callParticipants.callId, calls.id))
      .where(
        and(
          eq(callParticipants.userId, userId),
          ne(calls.id, callId),
          eq(calls.status, 'active'),
          isNotNull(callParticipants.joinedAt),
          isNull(callParticipants.leftAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
}

function toCall(call: CallRow, participants: (typeof callParticipants.$inferSelect)[]): Call {
  return {
    id: call.id,
    conversationId: call.conversationId,
    initiatorId: call.initiatorId,
    type: call.type,
    status: call.status,
    startedAt: call.startedAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    createdAt: call.createdAt.toISOString(),
    participants: participants.map((p) => ({
      userId: p.userId,
      joinedAt: p.joinedAt?.toISOString() ?? null,
      leftAt: p.leftAt?.toISOString() ?? null,
    })),
  };
}
