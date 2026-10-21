import { compareMessages, type Message } from '@linka/shared';

/**
 * Combines messages from any source (a history page, the send response, a realtime event,
 * a refetch after reconnecting) into one list. The message id is the identity, so a message
 * that arrives twice appears once; the result is always ordered by (createdAt, id),
 * never by arrival order.
 */
export function mergeMessages(existing: readonly Message[], incoming: readonly Message[]): Message[] {
  if (incoming.length === 0) return existing as Message[];
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages);
}
