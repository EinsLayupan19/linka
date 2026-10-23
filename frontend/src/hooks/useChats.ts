import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  compareMessages,
  type Conversation,
  type ConversationActivityEvent,
  type Call,
  type ConversationChangedEvent,
  type Message,
} from '@linka/shared';
import { toApiError, type ApiError } from '../lib/api';
import { listConversations } from '../services/conversations';
import { subscribeToUser, type LiveStatus } from '../services/realtime';
import { createDeliveryReporter, type DeliveryReporter } from '../services/receipts';

export type ConversationListState =
  | { status: 'loading' }
  | { status: 'ready'; conversations: Conversation[] }
  | { status: 'error'; error: ApiError };

export interface ChatsContextValue {
  list: ConversationListState;
  listStatus: LiveStatus;
  refresh: () => void;
  /** A message was sent or received in this tab: update its conversation's preview. */
  applyMessage: (message: Message) => void;
  /** A conversation was opened or created. */
  upsertConversation: (conversation: Conversation) => void;
  /** The user's read marker moved (this tab or another): update the unread count. */
  applyRead: (conversationId: string, lastReadAt: string) => void;
  /** Batches delivery receipts for every conversation. */
  delivery: DeliveryReporter;
}

/** Most recent activity first; id breaks ties so the order never flickers. */
function sortByActivity(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1,
  );
}

const myMember = (conversation: Conversation, myUserId: string) =>
  conversation.members.find((m) => m.userId === myUserId);

/**
 * The signed-in user's conversations, kept live by ONE realtime subscription: their own
 * private user channel (`user:<id>`), whatever the number of conversations.
 *
 * Unread counts come from the server; live events only adjust them, idempotently (each message
 * id counts once), and every (re)join refetches the authoritative list.
 */
/** Other things the user channel carries, for whoever needs them (calls). */
export interface UserChannelListeners {
  onCall?: (call: Call) => void;
  /** After every (re)join of the user channel. */
  onJoined?: () => void;
}

export function useConversationList(
  myUserId: string,
  activeConversationId: string | null,
  listeners: UserChannelListeners = {},
): ChatsContextValue {
  const listenersRef = useRef(listeners);
  useEffect(() => {
    listenersRef.current = listeners;
  });
  const [list, setList] = useState<ConversationListState>({ status: 'loading' });
  const [listStatus, setListStatus] = useState<LiveStatus>('connecting');
  const [attempt, setAttempt] = useState(0);
  const delivery = useMemo(() => createDeliveryReporter(), []);
  useEffect(() => () => delivery.dispose(), [delivery]);

  /** Message ids already counted into each conversation's unread count since the last fetch. */
  const counted = useRef(new Map<string, Set<string>>());
  const active = useRef(activeConversationId);
  useEffect(() => {
    active.current = activeConversationId;
  }, [activeConversationId]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * Messages shown before the list had loaded (e.g. sent right after opening a conversation).
   * The list may have been read before they existed, so they are applied once it arrives.
   */
  const early = useRef(new Map<string, Message>());

  /** Shows `message` as the conversation's latest; counts it as unread when that applies. */
  const showMessage = useCallback(
    (message: Message, { countUnread }: { countUnread: boolean }) => {
      let known = true;
      setList((current) => {
        if (current.status !== 'ready') {
          early.current.set(message.id, message); // keyed by id, so repeating this is harmless
          return current;
        }
        const conversation = current.conversations.find((c) => c.id === message.conversationId);
        if (!conversation) {
          known = false;
          return current;
        }

        const seen = counted.current.get(conversation.id) ?? new Set<string>();
        const myLastRead = myMember(conversation, myUserId)?.lastReadAt ?? null;
        const isUnread =
          countUnread &&
          message.senderId !== myUserId &&
          !seen.has(message.id) &&
          (myLastRead === null || message.createdAt > myLastRead) &&
          active.current !== conversation.id;
        if (isUnread) {
          seen.add(message.id);
          counted.current.set(conversation.id, seen);
        }

        const isNewer = !conversation.lastMessage || compareMessages(conversation.lastMessage, message) < 0;
        if (!isNewer && !isUnread) return current;
        const updated: Conversation = {
          ...conversation,
          lastMessage: isNewer ? message : conversation.lastMessage,
          updatedAt: message.createdAt > conversation.updatedAt ? message.createdAt : conversation.updatedAt,
          unreadCount: isUnread ? conversation.unreadCount + 1 : conversation.unreadCount,
        };
        return {
          status: 'ready',
          conversations: sortByActivity(current.conversations.map((c) => (c.id === updated.id ? updated : c))),
        };
      });
      if (!known) refresh();
    },
    [myUserId, refresh],
  );

  const applyMessage = useCallback((message: Message) => showMessage(message, { countUnread: false }), [showMessage]);

  useEffect(() => {
    const controller = new AbortController();
    listConversations(controller.signal).then(
      (conversations) => {
        counted.current.clear();
        setList({ status: 'ready', conversations });
        // Preview and order only: the server's unread counts are authoritative and may already
        // include these messages.
        const pending = [...early.current.values()];
        early.current.clear();
        for (const message of pending) showMessage(message, { countUnread: false });
        // Everything in the list has now reached this client.
        for (const conversation of conversations) {
          delivery.seed(conversation.id, myMember(conversation, myUserId)?.lastDeliveredAt ?? null);
          const last = conversation.lastMessage;
          if (last && last.senderId !== myUserId) delivery.report(conversation.id, last.createdAt);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setList({ status: 'error', error: toApiError(error) });
      },
    );
    return () => controller.abort();
  }, [attempt, delivery, myUserId, showMessage]);

  const applyRead = useCallback(
    (conversationId: string, lastReadAt: string) => {
      let needsRefresh = false;
      setList((current) => {
        if (current.status !== 'ready') return current;
        return {
          status: 'ready',
          conversations: current.conversations.map((conversation) => {
            if (conversation.id !== conversationId) return conversation;
            const members = conversation.members.map((m) =>
              m.userId === myUserId && (!m.lastReadAt || m.lastReadAt < lastReadAt) ? { ...m, lastReadAt } : m,
            );
            const last = conversation.lastMessage;
            const readEverything = !last || last.createdAt <= lastReadAt;
            // Partially read: only the server can count what is left.
            if (!readEverything) needsRefresh = true;
            if (readEverything) counted.current.delete(conversationId);
            return { ...conversation, members, unreadCount: readEverything ? 0 : conversation.unreadCount };
          }),
        };
      });
      if (needsRefresh) refresh();
    },
    [myUserId, refresh],
  );

  const upsertConversation = useCallback((conversation: Conversation) => {
    setList((current) => {
      if (current.status !== 'ready') return current;
      const others = current.conversations.filter((c) => c.id !== conversation.id);
      return { status: 'ready', conversations: sortByActivity([conversation, ...others]) };
    });
  }, []);

  const onChanged = useCallback(
    (event: ConversationChangedEvent) => {
      if (event.change !== 'removed') return refresh();
      counted.current.delete(event.conversationId);
      setList((current) =>
        current.status === 'ready'
          ? { status: 'ready', conversations: current.conversations.filter((c) => c.id !== event.conversationId) }
          : current,
      );
    },
    [refresh],
  );

  // One live subscription for the whole list.
  useEffect(() => {
    return subscribeToUser(myUserId, {
      onActivity: (event: ConversationActivityEvent) => {
        showMessage(event.lastMessage, { countUnread: true });
        if (event.lastMessage.senderId !== myUserId) delivery.report(event.conversationId, event.lastMessage.createdAt);
      },
      onRead: (event) => applyRead(event.conversationId, event.lastReadAt),
      onChanged,
      onCall: (call) => listenersRef.current.onCall?.(call),
      onStatus: setListStatus,
      // Events sent while disconnected are not replayed: start from the server again.
      onJoined: () => {
        refresh();
        listenersRef.current.onJoined?.();
      },
    });
  }, [myUserId, showMessage, applyRead, onChanged, refresh, delivery]);

  return { list, listStatus, refresh, applyMessage, upsertConversation, applyRead, delivery };
}

export const ChatsContext = createContext<ChatsContextValue | null>(null);

/** The conversation list, shared by the signed-in pages (see SignedInLayout). */
export function useChats(): ChatsContextValue {
  const value = useContext(ChatsContext);
  if (!value) throw new Error('useChats must be used inside the signed-in layout');
  return value;
}
