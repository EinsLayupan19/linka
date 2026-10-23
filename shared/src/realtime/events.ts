import { z } from 'zod';
import { callSchema } from '../calls/call.js';
import { messageSchema } from '../messages/message.js';

/*
 * Realtime contracts. Every channel is private (RLS on Supabase's realtime.messages):
 *
 * | Topic                 | Joins           | Publishes      | Events                                            |
 * | --------------------- | --------------- | -------------- | ------------------------------------------------- |
 * | conversation:<id>     | members         | database only  | message.created, receipt.updated, conversation.updated |
 * | live:<id>             | members         | members        | typing (broadcast), presence                      |
 * | user:<userId>         | that user only  | database only  | conversation.activity, conversation.read, conversation.changed, call.updated |
 * | call:<callId>         | the call's participants, while it rings or is active | those participants | signal (WebRTC offer/answer/ICE) |
 *
 * Server events and member-published events live on different topics on purpose: Supabase
 * authorizes publishing per channel join, not per event, so a channel members may publish on
 * could otherwise carry forged server events.
 */

export const conversationTopic = (conversationId: string) => `conversation:${conversationId}`;
export const liveTopic = (conversationId: string) => `live:${conversationId}`;
export const userTopic = (userId: string) => `user:${userId}`;
export const callTopic = (callId: string) => `call:${callId}`;

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

// --- user:<userId>: calls (published by the database) ---

/** A call the user takes part in started or changed state. Payload: a Call. */
export const CALL_UPDATED_EVENT = 'call.updated';
export const callUpdatedEventSchema = callSchema;

// --- call:<callId> (published by the call's participants) ---

/**
 * WebRTC signaling. Media never passes through Linka: these messages only let the two browsers
 * find each other. Each browser tab in a call has its own random `session`, so a call moved to
 * another tab (or a reloaded page) never mixes with the old one: messages carry the sender's
 * session and, except `ready` and `media`, the session they are meant for.
 *
 * - ready: "this tab is in the call and listening" (sent on every (re)join)
 * - offer / answer: SDP, the caller always offers. `connection` names the RTCPeerConnection: a new
 *   one means "start over", the same one is a renegotiation (ICE restart)
 * - ice: candidates for that connection, batched to stay well under Realtime's message limits
 * - media: microphone muted or not (shown to the other person)
 * - bye: "your session has been replaced; stop"
 */
export const CALL_SIGNAL_EVENT = 'signal';
export const CALL_SIGNAL_MAX_CANDIDATES = 50;

const callSessionSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid session.');
const signalBase = { callId: z.uuid(), from: z.uuid(), session: callSessionSchema };
const sdpSchema = z.string().min(1).max(100_000);

export const iceCandidateSchema = z.object({
  candidate: z.string().max(2000),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

export const callSignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), ...signalBase }),
  z.object({ kind: z.literal('offer'), ...signalBase, to: callSessionSchema, connection: callSessionSchema, sdp: sdpSchema }),
  z.object({ kind: z.literal('answer'), ...signalBase, to: callSessionSchema, connection: callSessionSchema, sdp: sdpSchema }),
  z.object({
    kind: z.literal('ice'),
    ...signalBase,
    to: callSessionSchema,
    connection: callSessionSchema,
    candidates: z.array(iceCandidateSchema).min(1).max(CALL_SIGNAL_MAX_CANDIDATES),
  }),
  z.object({ kind: z.literal('media'), ...signalBase, muted: z.boolean() }),
  z.object({ kind: z.literal('bye'), ...signalBase, to: callSessionSchema }),
]);

export type CallSignal = z.infer<typeof callSignalSchema>;
export type IceCandidate = z.infer<typeof iceCandidateSchema>;
