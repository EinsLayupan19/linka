import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  CONVERSATION_ACTIVITY_EVENT,
  CONVERSATION_CHANGED_EVENT,
  CONVERSATION_READ_EVENT,
  CONVERSATION_UPDATED_EVENT,
  conversationActivityEventSchema,
  conversationChangedEventSchema,
  conversationReadEventSchema,
  conversationTopic,
  conversationUpdatedEventSchema,
  liveTopic,
  MESSAGE_CREATED_EVENT,
  messageSchema,
  presenceStateSchema,
  RECEIPT_UPDATED_EVENT,
  receiptUpdatedEventSchema,
  TYPING_EVENT,
  typingEventSchema,
  userTopic,
  type ConversationActivityEvent,
  type ConversationChangedEvent,
  type ConversationReadEvent,
  type Message,
  type ReceiptUpdatedEvent,
  type TypingEvent,
} from '@linka/shared';
import type { z } from 'zod';
import { getSupabase } from '../lib/supabase';

/**
 * - connecting: joining the channel for the first time
 * - live: joined; events arrive as they happen
 * - reconnecting: the connection dropped or was refused; supabase-js keeps retrying on its own
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

interface ChannelLifecycle {
  onStatus?: (status: LiveStatus) => void;
  /**
   * Called every time the channel (re)joins. Events sent while not joined are not replayed,
   * so callers refetch authoritative data here.
   */
  onJoined?: () => void;
}

/** Never trust an event blindly: it must match its shared contract. */
function listen<T>(channel: RealtimeChannel, event: string, schema: z.ZodType<T>, handler: (payload: T) => void, isLeft: () => boolean) {
  channel.on('broadcast', { event }, ({ payload }: { payload: unknown }) => {
    if (isLeft()) return;
    const parsed = schema.safeParse(payload);
    if (parsed.success) handler(parsed.data);
  });
}

/**
 * Joins a private channel (Supabase authorizes it with RLS on realtime.messages), reporting
 * status and every (re)join. Returns the channel and a function that leaves it.
 */
function joinPrivate(
  topic: string,
  options: { presenceKey?: string },
  lifecycle: ChannelLifecycle & { onSubscribed?: (channel: RealtimeChannel) => void },
  setup: (channel: RealtimeChannel, isLeft: () => boolean) => void,
) {
  const supabase = getSupabase();
  let left = false;
  const isLeft = () => left;

  const channel = supabase.channel(topic, {
    config: options.presenceKey ? { private: true, presence: { key: options.presenceKey } } : { private: true },
  });
  setup(channel, isLeft);
  lifecycle.onStatus?.('connecting');

  // Private channels need the user's access token before joining.
  void supabase.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (left) return;
      channel.subscribe((status) => {
        if (left) return;
        if (status === 'SUBSCRIBED') {
          lifecycle.onStatus?.('live');
          lifecycle.onSubscribed?.(channel);
          lifecycle.onJoined?.();
        } else {
          // CHANNEL_ERROR, TIMED_OUT, or CLOSED while we still want the channel.
          lifecycle.onStatus?.('reconnecting');
        }
      });
    });

  return {
    channel,
    isJoined: () => !left,
    leave: () => {
      left = true;
      void supabase.removeChannel(channel);
    },
  };
}

// --- conversation:<id> -------------------------------------------------------------------

export interface ConversationSubscriptionHandlers extends ChannelLifecycle {
  onMessage: (message: Message) => void;
  onReceipt?: (event: ReceiptUpdatedEvent) => void;
  /** Members, roles or the name changed: refetch the conversation. */
  onConversationUpdated?: () => void;
}

/**
 * The open conversation's server events (messages, receipts, updates). Only members may join,
 * and only the database publishes here. Returns a function that leaves the channel.
 */
export function subscribeToConversation(conversationId: string, handlers: ConversationSubscriptionHandlers): () => void {
  const { leave } = joinPrivate(conversationTopic(conversationId), {}, handlers, (channel, isLeft) => {
    listen(channel, MESSAGE_CREATED_EVENT, messageSchema, (message) => {
      if (message.conversationId === conversationId) handlers.onMessage(message);
    }, isLeft);
    listen(channel, RECEIPT_UPDATED_EVENT, receiptUpdatedEventSchema, (event) => {
      if (event.conversationId === conversationId) handlers.onReceipt?.(event);
    }, isLeft);
    listen(channel, CONVERSATION_UPDATED_EVENT, conversationUpdatedEventSchema, (event) => {
      if (event.conversationId === conversationId) handlers.onConversationUpdated?.();
    }, isLeft);
  });
  return leave;
}

// --- user:<userId> -----------------------------------------------------------------------

export interface UserSubscriptionHandlers extends ChannelLifecycle {
  onActivity: (event: ConversationActivityEvent) => void;
  onRead: (event: ConversationReadEvent) => void;
  onChanged: (event: ConversationChangedEvent) => void;
}

/**
 * The signed-in user's own channel: list-level events for all their conversations, so one
 * subscription keeps the whole conversation list live. Only that user may join.
 */
export function subscribeToUser(userId: string, handlers: UserSubscriptionHandlers): () => void {
  const { leave } = joinPrivate(userTopic(userId), {}, handlers, (channel, isLeft) => {
    listen(channel, CONVERSATION_ACTIVITY_EVENT, conversationActivityEventSchema, handlers.onActivity, isLeft);
    listen(channel, CONVERSATION_READ_EVENT, conversationReadEventSchema, handlers.onRead, isLeft);
    listen(channel, CONVERSATION_CHANGED_EVENT, conversationChangedEventSchema, handlers.onChanged, isLeft);
  });
  return leave;
}

// --- live:<id> (presence + typing) -------------------------------------------------------

export interface LiveConversationHandlers extends ChannelLifecycle {
  /** Everyone currently present (validated user ids, possibly including yourself). */
  onPresence: (userIds: string[]) => void;
  onTyping: (event: TypingEvent) => void;
}

export interface LiveConversation {
  /** Broadcasts that you are (or stopped) typing. Ignored until joined. */
  sendTyping: (typing: boolean) => void;
  leave: () => void;
}

/**
 * The open conversation's ephemeral channel: Presence (who has it open) and typing broadcasts.
 * Nothing here is stored. Members may join and publish; outsiders may do neither.
 */
export function joinLiveConversation(conversationId: string, userId: string, handlers: LiveConversationHandlers): LiveConversation {
  let joined = false;

  const live = joinPrivate(
    liveTopic(conversationId),
    { presenceKey: userId },
    {
      onStatus: (status) => {
        joined = status === 'live';
        handlers.onStatus?.(status);
      },
      onSubscribed: (channel) => {
        void channel.track({ userId });
      },
      ...(handlers.onJoined ? { onJoined: handlers.onJoined } : {}),
    },
    (channel, isLeft) => {
      channel.on('presence', { event: 'sync' }, () => {
        if (isLeft()) return;
        const entries = Object.values(channel.presenceState()).flat();
        const userIds = new Set<string>();
        for (const entry of entries) {
          const parsed = presenceStateSchema.safeParse(entry);
          if (parsed.success) userIds.add(parsed.data.userId);
        }
        handlers.onPresence([...userIds]);
      });
      listen(channel, TYPING_EVENT, typingEventSchema, (event) => {
        if (event.conversationId === conversationId) handlers.onTyping(event);
      }, isLeft);
    },
  );

  return {
    sendTyping: (typing) => {
      if (!joined || !live.isJoined()) return;
      void live.channel.send({ type: 'broadcast', event: TYPING_EVENT, payload: { conversationId, userId, typing } });
    },
    leave: live.leave,
  };
}
