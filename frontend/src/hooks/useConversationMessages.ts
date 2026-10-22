import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Attachment, Message, ReceiptUpdatedEvent } from '@linka/shared';
import { toApiError } from '../lib/api';
import { listMessages, sendMessage } from '../services/messages';
import { subscribeToConversation, type LiveStatus } from '../services/realtime';
import { conversationMessagesReducer, initialMessagesState } from './conversationMessagesReducer';

export interface ConversationMessagesOptions {
  /** A message was sent or received (for the conversation list preview). */
  onActivity?: (message: Message) => void;
  /** Messages reached this client (history or realtime), for delivery receipts. */
  onReceived?: (messages: Message[]) => void;
  /** A member's read/delivery markers changed. */
  onReceipt?: (event: ReceiptUpdatedEvent) => void;
  /** Members, roles or the name changed. */
  onConversationUpdated?: () => void;
}

/**
 * Everything the conversation view needs about messages:
 * - the newest page on open, older pages on demand (cursor pagination)
 * - new messages live from the conversation's private realtime channel, joined only while
 *   this conversation is open and left when it closes
 * - after every (re)join, the newest page again, merged by id, so nothing sent while
 *   disconnected is missed
 * - sending (text and/or uploaded attachments) with a pending state, failure and retry;
 *   retries reuse the clientId so the server never stores a message twice
 */
export function useConversationMessages(conversationId: string, options: ConversationMessagesOptions = {}) {
  const [state, dispatch] = useReducer(conversationMessagesReducer, initialMessagesState);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [attempt, setAttempt] = useState(0);

  // Latest values for async callbacks, without re-subscribing when they change.
  const optionsRef = useRef(options);
  const activeConversation = useRef(conversationId);
  useEffect(() => {
    optionsRef.current = options;
    activeConversation.current = conversationId;
  });

  // Initial page.
  useEffect(() => {
    dispatch({ type: 'reset' });
    const controller = new AbortController();
    listMessages(conversationId, { signal: controller.signal }).then(
      (page) => {
        dispatch({ type: 'loaded', page });
        optionsRef.current.onReceived?.(page.messages);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) dispatch({ type: 'loadFailed', error: toApiError(error) });
      },
    );
    return () => controller.abort();
  }, [conversationId, attempt]);

  // Realtime, once the conversation loaded (a failed load means no access or no network).
  const isReady = state.status === 'ready';
  useEffect(() => {
    if (!isReady) return;
    let refetch: AbortController | null = null;

    const unsubscribe = subscribeToConversation(conversationId, {
      onMessage: (message) => {
        dispatch({ type: 'received', messages: [message] });
        optionsRef.current.onActivity?.(message);
        optionsRef.current.onReceived?.([message]);
      },
      onReceipt: (event) => optionsRef.current.onReceipt?.(event),
      onConversationUpdated: () => optionsRef.current.onConversationUpdated?.(),
      onStatus: setLiveStatus,
      onJoined: () => {
        refetch?.abort();
        const controller = new AbortController();
        refetch = controller;
        listMessages(conversationId, { signal: controller.signal }).then(
          (page) => {
            dispatch({ type: 'latestRefetched', page });
            optionsRef.current.onReceived?.(page.messages);
          },
          // Best effort: the view keeps what it has and the next join tries again.
          () => undefined,
        );
      },
    });

    return () => {
      refetch?.abort();
      unsubscribe();
    };
  }, [conversationId, isReady]);

  const deliver = useCallback(
    (clientId: string, content: string, attachments: Attachment[]) => {
      const target = conversationId;
      sendMessage(target, {
        clientId,
        ...(content ? { content } : {}),
        ...(attachments.length > 0 ? { attachmentIds: attachments.map((a) => a.id) } : {}),
      }).then(
        (message) => {
          if (activeConversation.current === target) dispatch({ type: 'received', messages: [message] });
          optionsRef.current.onActivity?.(message);
        },
        (error: unknown) => {
          if (activeConversation.current === target) {
            dispatch({ type: 'sendFailed', clientId, error: toApiError(error).message });
          }
        },
      );
    },
    [conversationId],
  );

  const send = useCallback(
    (content: string, attachments: Attachment[] = []) => {
      const clientId = crypto.randomUUID();
      dispatch({
        type: 'sendStarted',
        pending: { clientId, content, attachments, createdAt: new Date().toISOString(), status: 'sending' },
      });
      deliver(clientId, content, attachments);
    },
    [deliver],
  );

  const retry = useCallback(
    (clientId: string) => {
      const pending = state.pending.find((p) => p.clientId === clientId);
      if (!pending || pending.status !== 'failed') return;
      dispatch({ type: 'sendRetried', clientId });
      deliver(clientId, pending.content, pending.attachments);
    },
    [deliver, state.pending],
  );

  const loadOlder = useCallback(() => {
    if (!state.nextCursor || state.older === 'loading') return;
    const target = conversationId;
    dispatch({ type: 'olderStarted' });
    listMessages(target, { before: state.nextCursor }).then(
      (page) => {
        if (activeConversation.current === target) dispatch({ type: 'olderLoaded', page });
      },
      () => {
        if (activeConversation.current === target) dispatch({ type: 'olderFailed' });
      },
    );
  }, [conversationId, state.nextCursor, state.older]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, liveStatus, send, retry, loadOlder, reload };
}
