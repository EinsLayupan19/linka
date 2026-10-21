import { z } from 'zod';
import { messageSchema } from '../messages/message.js';
import { userSummarySchema } from '../profiles/profile.js';

export const CONVERSATION_NAME_MAX_LENGTH = 100;
/** Includes the owner. Keeps member lists (and fan-out later) bounded. */
export const GROUP_MAX_MEMBERS = 100;

export const CONVERSATION_TYPES = ['direct', 'group'] as const;
export const conversationTypeSchema = z.enum(CONVERSATION_TYPES);
export type ConversationType = z.infer<typeof conversationTypeSchema>;

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export const memberRoleSchema = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const conversationNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a group name.')
  .max(CONVERSATION_NAME_MAX_LENGTH, `Use at most ${CONVERSATION_NAME_MAX_LENGTH} characters.`);

const userIdSchema = z.uuid('Invalid user id.');

/**
 * Body of POST /api/conversations. The creator is always the signed-in user
 * (from the access token), so it never appears here.
 */
export const createConversationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('direct'),
    /** The other person. A 1:1 conversation always has exactly two members. */
    userId: userIdSchema,
  }),
  z.strictObject({
    type: z.literal('group'),
    name: conversationNameSchema,
    /** Everyone to add besides the creator. */
    memberIds: z
      .array(userIdSchema)
      .min(1, 'Add at least one member.')
      .max(GROUP_MAX_MEMBERS - 1, `A group can have at most ${GROUP_MAX_MEMBERS} members.`),
  }),
]);

export type CreateConversationInput = z.infer<typeof createConversationSchema>;

/** Body of PATCH /api/conversations/:conversationId (groups only). */
export const updateConversationSchema = z.strictObject({
  name: conversationNameSchema,
});

export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

/** Body of POST /api/conversations/:conversationId/members. */
export const addMembersSchema = z.strictObject({
  userIds: z
    .array(userIdSchema)
    .min(1, 'Choose at least one person.')
    .max(GROUP_MAX_MEMBERS - 1, `A group can have at most ${GROUP_MAX_MEMBERS} members.`),
});

export type AddMembersInput = z.infer<typeof addMembersSchema>;

/**
 * Body of PATCH /api/conversations/:conversationId/members/:userId.
 * Setting "owner" transfers ownership; the previous owner becomes an admin.
 */
export const updateMemberRoleSchema = z.strictObject({
  role: memberRoleSchema,
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const conversationMemberSchema = userSummarySchema
  .omit({ id: true })
  .extend({
    userId: z.uuid(),
    role: memberRoleSchema,
    joinedAt: z.iso.datetime({ offset: true }),
  });

export type ConversationMember = z.infer<typeof conversationMemberSchema>;

export const conversationSchema = z.object({
  id: z.uuid(),
  type: conversationTypeSchema,
  /** Groups only; 1:1 conversations are shown by the other member's name. */
  name: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Last activity: a new message or a change to the conversation. Lists are sorted by it. */
  updatedAt: z.iso.datetime({ offset: true }),
  members: z.array(conversationMemberSchema),
  /** The newest message, for list previews; null when there are none. */
  lastMessage: messageSchema.nullable(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListSchema = z.object({
  conversations: z.array(conversationSchema),
});

export type ConversationList = z.infer<typeof conversationListSchema>;
