import { z } from 'zod';
import { messageSchema } from '../messages/message.js';

/*
 * Realtime contracts. Every channel is private (RLS on Supabase's realtime.messages):
 *
 * | Topic                 | Joins           | Publishes      | Events                                            |
 * | --------------------- | --------------- | -------------- | ------------------------------------------------- |
 * | conversation:<id>     | members         | database only  | message.created, receipt.updated, conversation.updated |
 * | live:<id>             | members         | members        | typing (broadcast), presence                      |
 * | user:<userId>         | that user only  | database only  | conversation.activity, conversation.read, conversation.changed |
 *
 * Server events and member-published events live on different topics on purpose: Supabase
 * authorizes publishing per channel join, not per event, so a channel members may publish on
 * could otherwise carry forged server events.
 */

export const conversationTopic = (conversationId: string) => `conversation:${conversationId}`;
export const liveTopic = (conversationId: string) => `live:${conversationId}`;
export const userTopic = (userId: string) => `user:${userId}`;

const timestamp = z.iso.datetime();

// --- conversation:<id> (published by the database) ---

/** Payload: a Message. */
export const MESSAGE_CREATED_EVENT = 'message.created';

/** A member's read/delivery markers changed. */
export const RECEIPT_UPDATED_EVENT = 'receipt.updated';
export const receiptUpdatedEventSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
  lastDeliveredAt: timestamp.nullable(),
  lastReadAt: timestamp.nullable(),
});
export type ReceiptUpdatedEvent = z.infer<typeof receiptUpdatedEventSchema>;

/** Members, roles or the name changed: refetch the conversation. */
export const CONVERSATION_UPDATED_EVENT = 'conversation.updated';
export const conversationUpdatedEventSchema = z.object({ conversationId: z.uuid() });
export type ConversationUpdatedEvent = z.infer<typeof conversationUpdatedEventSchema>;

// --- live:<id> (published by members' clients) ---

/** Sent at most every TYPING_THROTTLE_MS while typing, and once with typing: false when stopping. */
export const TYPING_EVENT = 'typing';
export const typingEventSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
  typing: z.boolean(),
});
export type TypingEvent = z.infer<typeof typingEventSchema>;

/** What each client tracks in Presence on live:<id>. */
export const presenceStateSchema = z.object({ userId: z.uuid() });
export type PresenceStateEntry = z.infer<typeof presenceStateSchema>;

export const TYPING_THROTTLE_MS = 2000;
/** A typing indicator disappears this long after the last typing event. */
export const TYPING_TIMEOUT_MS = 3000;

// --- user:<userId> (published by the database) ---

/** A new message in one of the user's conversations (including their own, for other tabs). */
export const CONVERSATION_ACTIVITY_EVENT = 'conversation.activity';
export const conversationActivityEventSchema = z.object({
  conversationId: z.uuid(),
  lastMessage: messageSchema,
});
export type ConversationActivityEvent = z.infer<typeof conversationActivityEventSchema>;

/** The user's own read marker moved (e.g. read in another tab). */
export const CONVERSATION_READ_EVENT = 'conversation.read';
export const conversationReadEventSchema = z.object({
  conversationId: z.uuid(),
  lastReadAt: timestamp,
});
export type ConversationReadEvent = z.infer<typeof conversationReadEventSchema>;

/** The user was added to or removed from a conversation, or it was renamed or its members changed. */
export const CONVERSATION_CHANGED_EVENT = 'conversation.changed';
export const conversationChangedEventSchema = z.object({
  conversationId: z.uuid(),
  change: z.enum(['added', 'removed', 'updated']),
});
export type ConversationChangedEvent = z.infer<typeof conversationChangedEventSchema>;
