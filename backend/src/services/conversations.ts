import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import {
  ErrorCode,
  GROUP_MAX_MEMBERS,
  type AddMembersInput,
  type Conversation,
  type ConversationMember,
  type CreateConversationInput,
  type MemberRole,
  type UpdateConversationInput,
} from '@linka/shared';
import type { Database } from '../db/client.js';
import { postgresErrorCode, UNIQUE_VIOLATION } from '../db/errors.js';
import { conversationMembers, conversations, profiles, type ConversationRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { canAddMembers, canChangeRole, canEditGroup, removalDecision } from './conversationPermissions.js';
import { requireMembership } from './membership.js';

export const CONVERSATION_LIST_LIMIT = 50;

/** Conversation operations. `userId` is always the signed-in user from the access token. */
export interface ConversationStore {
  listForUser(userId: string): Promise<Conversation[]>;
  getForUser(userId: string, conversationId: string): Promise<Conversation>;
  /** For 1:1 conversations, returns the existing one (created: false) instead of a duplicate. */
  create(userId: string, input: CreateConversationInput): Promise<{ conversation: Conversation; created: boolean }>;
  rename(userId: string, conversationId: string, input: UpdateConversationInput): Promise<Conversation>;
  addMembers(userId: string, conversationId: string, input: AddMembersInput): Promise<Conversation>;
  updateMemberRole(userId: string, conversationId: string, targetUserId: string, role: MemberRole): Promise<Conversation>;
  /** Removes another member, or leaves when targetUserId is the caller. */
  removeMember(userId: string, conversationId: string, targetUserId: string): Promise<void>;
}

const forbidden = (message: string) => new AppError(403, ErrorCode.Forbidden, message);
const groupsOnly = () => new AppError(400, ErrorCode.BadRequest, 'Only group conversations can be changed like this.');
const memberNotFound = () => new AppError(404, ErrorCode.MemberNotFound, 'That person is not in this conversation.');

/** 1:1 pairs are stored low id first, so (A, B) and (B, A) map to the same row. */
function directPair(a: string, b: string): { directLowUserId: string; directHighUserId: string } {
  return a < b ? { directLowUserId: a, directHighUserId: b } : { directLowUserId: b, directHighUserId: a };
}

export function createConversationStore(db: Database): ConversationStore {
  async function loadMembers(conversationIds: string[]): Promise<Map<string, ConversationMember[]>> {
    const rows =
      conversationIds.length === 0
        ? []
        : await db
            .select({
              conversationId: conversationMembers.conversationId,
              userId: conversationMembers.userId,
              role: conversationMembers.role,
              joinedAt: conversationMembers.joinedAt,
              username: profiles.username,
              displayName: profiles.displayName,
              avatarPath: profiles.avatarPath,
            })
            .from(conversationMembers)
            .innerJoin(profiles, eq(profiles.id, conversationMembers.userId))
            .where(inArray(conversationMembers.conversationId, conversationIds))
            .orderBy(asc(conversationMembers.joinedAt), asc(profiles.username));

    const byConversation = new Map<string, ConversationMember[]>();
    for (const { conversationId, joinedAt, ...member } of rows) {
      const list = byConversation.get(conversationId) ?? [];
      list.push({ ...member, joinedAt: joinedAt.toISOString() });
      byConversation.set(conversationId, list);
    }
    return byConversation;
  }

  function toConversation(row: ConversationRow, members: ConversationMember[]): Conversation {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      members,
    };
  }

  async function load(conversationId: string): Promise<Conversation> {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!row) throw new Error(`Conversation ${conversationId} disappeared`);
    const members = await loadMembers([row.id]);
    return toConversation(row, members.get(row.id) ?? []);
  }

  /** Throws a 400 naming the field if any of the ids has no profile. */
  async function assertUsersExist(userIds: string[], field: string) {
    if (userIds.length === 0) return;
    const found = await db.select({ id: profiles.id }).from(profiles).where(inArray(profiles.id, userIds));
    if (found.length !== userIds.length) {
      const message = userIds.length === 1 ? 'That user does not exist.' : 'Some of these users do not exist.';
      throw new AppError(400, ErrorCode.ValidationFailed, message, { [field]: message });
    }
  }

  async function findDirect(a: string, b: string): Promise<ConversationRow | undefined> {
    const pair = directPair(a, b);
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.directLowUserId, pair.directLowUserId),
          eq(conversations.directHighUserId, pair.directHighUserId),
        ),
      )
      .limit(1);
    return row;
  }

  async function createDirect(userId: string, otherUserId: string) {
    if (otherUserId === userId) {
      const message = 'You cannot start a conversation with yourself.';
      throw new AppError(400, ErrorCode.ValidationFailed, message, { userId: message });
    }
    await assertUsersExist([otherUserId], 'userId');

    const existing = await findDirect(userId, otherUserId);
    if (existing) return { conversation: await load(existing.id), created: false };

    try {
      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(conversations)
          .values({ type: 'direct', createdBy: userId, ...directPair(userId, otherUserId) })
          .returning({ id: conversations.id });
        if (!row) throw new Error('Insert returned no row');
        await tx.insert(conversationMembers).values([
          { conversationId: row.id, userId, role: 'member' },
          { conversationId: row.id, userId: otherUserId, role: 'member' },
        ]);
        return row.id;
      });
      return { conversation: await load(id), created: true };
    } catch (error) {
      // Both people started the conversation at the same moment: the unique pair wins once.
      if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
        const winner = await findDirect(userId, otherUserId);
        if (winner) return { conversation: await load(winner.id), created: false };
      }
      throw error;
    }
  }

  async function createGroup(userId: string, name: string, memberIds: string[]) {
    // The creator is always the owner; listing yourself (or someone twice) changes nothing.
    const others = [...new Set(memberIds)].filter((id) => id !== userId);
    if (others.length === 0) {
      throw new AppError(400, ErrorCode.ValidationFailed, 'Add at least one other member.', {
        memberIds: 'Add at least one other member.',
      });
    }
    await assertUsersExist(others, 'memberIds');

    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(conversations)
        .values({ type: 'group', name, createdBy: userId })
        .returning({ id: conversations.id });
      if (!row) throw new Error('Insert returned no row');
      await tx.insert(conversationMembers).values([
        { conversationId: row.id, userId, role: 'owner' as const },
        ...others.map((memberId) => ({ conversationId: row.id, userId: memberId, role: 'member' as const })),
      ]);
      return row.id;
    });
    return { conversation: await load(id), created: true };
  }

  async function requireGroupMember(conversationId: string, userId: string) {
    const membership = await requireMembership(db, conversationId, userId);
    if (membership.conversationType !== 'group') throw groupsOnly();
    return membership;
  }

  async function targetRole(conversationId: string, targetUserId: string): Promise<MemberRole> {
    const [row] = await db
      .select({ role: conversationMembers.role })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, targetUserId)))
      .limit(1);
    if (!row) throw memberNotFound();
    return row.role;
  }

  return {
    async listForUser(userId) {
      const rows = await db
        .select({ conversation: conversations })
        .from(conversationMembers)
        .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
        .where(eq(conversationMembers.userId, userId))
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(CONVERSATION_LIST_LIMIT);

      const members = await loadMembers(rows.map((r) => r.conversation.id));
      return rows.map(({ conversation }) => toConversation(conversation, members.get(conversation.id) ?? []));
    },

    async getForUser(userId, conversationId) {
      await requireMembership(db, conversationId, userId);
      return load(conversationId);
    },

    create(userId, input) {
      return input.type === 'direct'
        ? createDirect(userId, input.userId)
        : createGroup(userId, input.name, input.memberIds);
    },

    async rename(userId, conversationId, input) {
      const { role } = await requireGroupMember(conversationId, userId);
      if (!canEditGroup(role)) throw forbidden('Only the owner and admins can change the group.');

      await db.update(conversations).set({ name: input.name }).where(eq(conversations.id, conversationId));
      return load(conversationId);
    },

    async addMembers(userId, conversationId, input) {
      const { role } = await requireGroupMember(conversationId, userId);
      if (!canAddMembers(role)) throw forbidden('Only the owner and admins can add members.');

      const newIds = [...new Set(input.userIds)];
      const alreadyIn = await db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, conversationId), inArray(conversationMembers.userId, newIds)));
      if (alreadyIn.length > 0) {
        throw new AppError(409, ErrorCode.AlreadyMember, 'Some of these people are already in the group.');
      }
      await assertUsersExist(newIds, 'userIds');

      const [current] = await db
        .select({ total: count() })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId));
      if ((current?.total ?? 0) + newIds.length > GROUP_MAX_MEMBERS) {
        throw new AppError(400, ErrorCode.ValidationFailed, `A group can have at most ${GROUP_MAX_MEMBERS} members.`);
      }

      try {
        await db
          .insert(conversationMembers)
          .values(newIds.map((memberId) => ({ conversationId, userId: memberId, role: 'member' as const })));
      } catch (error) {
        // Someone else added the same person at the same moment; the primary key stops the duplicate.
        if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
          throw new AppError(409, ErrorCode.AlreadyMember, 'Some of these people are already in the group.');
        }
        throw error;
      }
      return load(conversationId);
    },

    async updateMemberRole(userId, conversationId, targetUserId, role) {
      const actor = await requireGroupMember(conversationId, userId);
      if (!canChangeRole(actor.role, targetUserId === userId)) {
        throw forbidden('Only the owner can change roles.');
      }
      const current = await targetRole(conversationId, targetUserId);
      if (current === role) return load(conversationId);

      const memberRow = (id: string) =>
        and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, id));

      if (role === 'owner') {
        // Transfer: the old owner steps down first, so there is never a moment with two owners.
        await db.transaction(async (tx) => {
          await tx.update(conversationMembers).set({ role: 'admin' }).where(memberRow(userId));
          await tx.update(conversationMembers).set({ role: 'owner' }).where(memberRow(targetUserId));
        });
      } else {
        await db.update(conversationMembers).set({ role }).where(memberRow(targetUserId));
      }
      return load(conversationId);
    },

    async removeMember(userId, conversationId, targetUserId) {
      const membership = await requireMembership(db, conversationId, userId);
      if (membership.conversationType !== 'group') {
        throw new AppError(400, ErrorCode.BadRequest, 'You cannot leave or remove people from a 1:1 conversation.');
      }
      const isSelf = targetUserId === userId;
      const role = isSelf ? membership.role : await targetRole(conversationId, targetUserId);

      const decision = removalDecision(membership.role, role, isSelf);
      if (decision === 'owner_must_transfer') {
        throw new AppError(409, ErrorCode.OwnerCannotLeave, 'Transfer ownership to someone else before leaving.');
      }
      if (decision === 'forbidden') throw forbidden('You cannot remove this member.');

      await db
        .delete(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, targetUserId)));
    },
  };
}
