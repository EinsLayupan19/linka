import { conversationTopic, MESSAGE_CREATED_EVENT, messageSchema, type Message } from '@linka/shared';
import { getSupabase } from '../lib/supabase';

/**
 * - connecting: joining the channel for the first time
 * - live: joined; new messages arrive as they are sent
 * - reconnecting: the connection dropped or was refused; supabase-js keeps retrying on its own
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

export interface ConversationSubscriptionHandlers {
  onMessage: (message: Message) => void;
  onStatus: (status: LiveStatus) => void;
  /**
   * Called every time the channel (re)joins. Events sent while not joined are not replayed,
   * so the caller refetches the newest messages here to fill any gap.
   */
  onJoined: () => void;
}

/**
 * Listens for new messages in one conversation on its private Broadcast channel
 * (`conversation:<id>`). Supabase only lets members join (RLS on realtime.messages), and only
 * the database publishes on it. Returns a function that leaves the channel.
 */
export function subscribeToConversation(conversationId: string, handlers: ConversationSubscriptionHandlers): () => void {
  const supabase = getSupabase();
  let left = false;

  const channel = supabase.channel(conversationTopic(conversationId), { config: { private: true } });

  channel.on('broadcast', { event: MESSAGE_CREATED_EVENT }, ({ payload }) => {
    if (left) return;
    // Never trust an event blindly: it must be a well-formed message for this conversation.
    const parsed = messageSchema.safeParse(payload);
    if (parsed.success && parsed.data.conversationId === conversationId) handlers.onMessage(parsed.data);
  });

  handlers.onStatus('connecting');

  // Private channels need the user's access token before joining.
  void supabase.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (left) return;
      channel.subscribe((status) => {
        if (left) return;
        if (status === 'SUBSCRIBED') {
          handlers.onStatus('live');
          handlers.onJoined();
        } else {
          // CHANNEL_ERROR, TIMED_OUT, or CLOSED while we still want the channel.
          handlers.onStatus('reconnecting');
        }
      });
    });

  return () => {
    left = true;
    void supabase.removeChannel(channel);
  };
}
