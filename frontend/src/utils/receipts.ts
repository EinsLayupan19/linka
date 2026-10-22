import type { Conversation, ConversationMember, Message } from '@linka/shared';

/**
 * Receipt text for one of my messages, derived from the other members' markers: a member has
 * received/read a message when their marker is at or after its createdAt. No per-message rows.
 * - 1:1: Sent -> Delivered -> Read
 * - groups: "Read by N" (only how many; who is not shown here), else Delivered/Sent
 */
export function receiptLabel(message: Pick<Message, 'createdAt'>, conversation: Pick<Conversation, 'type' | 'members'>, myUserId: string): string {
  const others = conversation.members.filter((m) => m.userId !== myUserId);
  const reached = (marker: string | null) => marker !== null && marker >= message.createdAt;
  const readers = others.filter((m) => reached(m.lastReadAt)).length;
  const receivers = others.filter((m) => reached(m.lastDeliveredAt) || reached(m.lastReadAt)).length;

  if (conversation.type === 'direct') {
    if (readers > 0) return 'Read';
    if (receivers > 0) return 'Delivered';
    return 'Sent';
  }
  if (readers > 0) return `Read by ${readers}`;
  if (receivers > 0) return 'Delivered';
  return 'Sent';
}

/** Applies a receipt.updated event to a member list (markers only move forward). */
export function withMarkers(
  members: ConversationMember[],
  update: { userId: string; lastDeliveredAt: string | null; lastReadAt: string | null },
): ConversationMember[] {
  const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);
  let changed = false;
  const next = members.map((m) => {
    if (m.userId !== update.userId) return m;
    const lastDeliveredAt = later(m.lastDeliveredAt, update.lastDeliveredAt);
    const lastReadAt = later(m.lastReadAt, update.lastReadAt);
    if (lastDeliveredAt === m.lastDeliveredAt && lastReadAt === m.lastReadAt) return m;
    changed = true;
    return { ...m, lastDeliveredAt, lastReadAt };
  });
  return changed ? next : members;
}

/** "Jonas is typing…", "Jonas and Maria are typing…", "3 people are typing…". */
export function typingLabel(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

/** Badge text for an unread count (the server caps counts at 100). */
export function unreadBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}
