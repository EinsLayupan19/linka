import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { compareMessages, type Conversation, type Message } from '@linka/shared';
import { toApiError, type ApiError } from '../lib/api';
import { listConversations } from '../services/conversations';

export type ConversationListState =
  | { status: 'loading' }
  | { status: 'ready'; conversations: Conversation[] }
  | { status: 'error'; error: ApiError };

export interface ChatsContextValue {
  list: ConversationListState;
  refresh: () => void;
  /** A message was sent or received: update its conversation's preview and move it up. */
  applyMessage: (message: Message) => void;
  /** A conversation was opened or created. */
  upsertConversation: (conversation: Conversation) => void;
}

/** Most recent activity first; id breaks ties so the order never flickers. */
function sortByActivity(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1,
  );
}

/**
 * The signed-in user's conversations. Loaded once, then kept current from what this tab sees
 * (its own sends and the open conversation's live messages), and refreshed when the tab is
 * shown again. Other conversations do not stream live yet.
 */
export function useConversationList(): ChatsContextValue {
  const [list, setList] = useState<ConversationListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listConversations(controller.signal).then(
      (conversations) => setList({ status: 'ready', conversations }),
      (error: unknown) => {
        if (!controller.signal.aborted) setList({ status: 'error', error: toApiError(error) });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  // Catch up when the user comes back to the tab (an event, not polling).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const applyMessage = useCallback(
    (message: Message) => {
      let known = true;
      setList((current) => {
        if (current.status !== 'ready') return current;
        const conversation = current.conversations.find((c) => c.id === message.conversationId);
        if (!conversation) {
          known = false;
          return current;
        }
        const isNewer = !conversation.lastMessage || compareMessages(conversation.lastMessage, message) < 0;
        if (!isNewer) return current;
        const updated: Conversation = {
          ...conversation,
          lastMessage: message,
          updatedAt: message.createdAt > conversation.updatedAt ? message.createdAt : conversation.updatedAt,
        };
        return {
          status: 'ready',
          conversations: sortByActivity(current.conversations.map((c) => (c.id === updated.id ? updated : c))),
        };
      });
      if (!known) refresh();
    },
    [refresh],
  );

  const upsertConversation = useCallback((conversation: Conversation) => {
    setList((current) => {
      if (current.status !== 'ready') return current;
      const others = current.conversations.filter((c) => c.id !== conversation.id);
      return { status: 'ready', conversations: sortByActivity([conversation, ...others]) };
    });
  }, []);

  return { list, refresh, applyMessage, upsertConversation };
}

export const ChatsContext = createContext<ChatsContextValue | null>(null);

/** The conversation list, shared by the chat pages. Only available inside <Chats>. */
export function useChats(): ChatsContextValue {
  const value = useContext(ChatsContext);
  if (!value) throw new Error('useChats must be used inside <Chats>');
  return value;
}
