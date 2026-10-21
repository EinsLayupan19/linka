import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Message } from '@linka/shared';
import { toApiError } from '../lib/api';
import { listMessages, sendMessage } from '../services/messages';
import { subscribeToConversation, type LiveStatus } from '../services/realtime';
import { conversationMessagesReducer, initialMessagesState } from './conversationMessagesReducer';

/**
 * Everything the conversation view needs about messages:
 * - the newest page on open, older pages on demand (cursor pagination)
 * - new messages live from the conversation's private realtime channel, joined only while
 *   this conversation is open and left when it closes
 * - after every (re)join, the newest page again, merged by id, so nothing sent while
 *   disconnected is missed
 * - sending with a pending state, failure and retry; retries reuse the clientId so the
 *   server never stores a message twice
 */
export function useConversationMessages(conversationId: string, onActivity?: (message: Message) => void) {
  const [state, dispatch] = useReducer(conversationMessagesReducer, initialMessagesState);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [attempt, setAttempt] = useState(0);

  // Latest values for async callbacks, without re-subscribing when they change.
  const onActivityRef = useRef(onActivity);
  const activeConversation = useRef(conversationId);
  useEffect(() => {
    onActivityRef.current = onActivity;
    activeConversation.current = conversationId;
  });

  // Initial page.
  useEffect(() => {
    dispatch({ type: 'reset' });
    const controller = new AbortController();
    listMessages(conversationId, { signal: controller.signal }).then(
      (page) => dispatch({ type: 'loaded', page }),
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
        onActivityRef.current?.(message);
      },
      onStatus: setLiveStatus,
      onJoined: () => {
        refetch?.abort();
        const controller = new AbortController();
        refetch = controller;
        listMessages(conversationId, { signal: controller.signal }).then(
          (page) => dispatch({ type: 'latestRefetched', page }),
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
    (clientId: string, content: string) => {
      const target = conversationId;
      sendMessage(target, { content, clientId }).then(
        (message) => {
          if (activeConversation.current === target) dispatch({ type: 'received', messages: [message] });
          onActivityRef.current?.(message);
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
    (content: string) => {
      const clientId = crypto.randomUUID();
      dispatch({ type: 'sendStarted', pending: { clientId, content, createdAt: new Date().toISOString(), status: 'sending' } });
      deliver(clientId, content);
    },
    [deliver],
  );

  const retry = useCallback(
    (clientId: string) => {
      const pending = state.pending.find((p) => p.clientId === clientId);
      if (!pending || pending.status !== 'failed') return;
      dispatch({ type: 'sendRetried', clientId });
      deliver(clientId, pending.content);
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
