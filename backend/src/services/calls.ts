import { eq } from 'drizzle-orm';
import { ErrorCode, type Call, type CallType } from '@linka/shared';
import type { Database } from '../db/client.js';
import { postgresErrorCode, UNIQUE_VIOLATION } from '../db/errors.js';
import { callParticipants, calls, conversationMembers } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { findMembership, requireMembership } from './membership.js';

// Database foundation for calls: who may create and see them, and who takes part.
// Signaling, the call lifecycle and WebRTC media arrive with the calling phases.

export interface CallStore {
  /** Starts a ringing call. Participants are exactly the conversation's current members. */
  start(userId: string, conversationId: string, type: CallType): Promise<Call>;
  /** A call the user may see because they belong to its conversation. */
  getForUser(userId: string, callId: string): Promise<Call>;
}

const callNotFound = () => new AppError(404, ErrorCode.NotFound, 'Call not found.');

export function createCallStore(db: Database): CallStore {
  async function load(callId: string): Promise<Call | null> {
    const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    if (!call) return null;
    const participants = await db.select().from(callParticipants).where(eq(callParticipants.callId, callId));
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

  return {
    async start(userId, conversationId, type) {
      await requireMembership(db, conversationId, userId);

      try {
        const callId = await db.transaction(async (tx) => {
          const [call] = await tx
            .insert(calls)
            .values({ conversationId, initiatorId: userId, type })
            .returning({ id: calls.id });
          if (!call) throw new Error('Insert returned no row');

          // Participants come from the membership table, so only members can ever be in a call.
          const members = await tx
            .select({ userId: conversationMembers.userId })
            .from(conversationMembers)
            .where(eq(conversationMembers.conversationId, conversationId));
          const now = new Date();
          await tx.insert(callParticipants).values(
            members.map((m) => ({ callId: call.id, userId: m.userId, joinedAt: m.userId === userId ? now : null })),
          );
          return call.id;
        });
        const call = await load(callId);
        if (!call) throw new Error(`Call ${callId} disappeared`);
        return call;
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
  };
}
