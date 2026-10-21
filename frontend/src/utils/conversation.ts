import type { Conversation, ConversationMember } from '@linka/shared';

/** The other person in a 1:1 conversation (undefined if their account was deleted). */
export function otherMember(conversation: Conversation, myUserId: string): ConversationMember | undefined {
  return conversation.members.find((member) => member.userId !== myUserId);
}

/** What to call a conversation: the group name, or the other person's display name. */
export function conversationTitle(conversation: Conversation, myUserId: string): string {
  if (conversation.type === 'group') return conversation.name ?? 'Group';
  return otherMember(conversation, myUserId)?.displayName ?? 'Deleted user';
}
