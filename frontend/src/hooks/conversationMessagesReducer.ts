import type { Attachment, Message, MessagePage } from '@linka/shared';
import type { ApiError } from '../lib/api';
import { mergeMessages } from '../utils/messageList';

/** A message the user sent that the server has not confirmed yet. */
export interface PendingMessage {
  clientId: string;
  /** '' for a message that is only attachments. */
  content: string;
  /** Already uploaded; sent with the message (and again on retry). */
  attachments: Attachment[];
  /** Local time, only for display while pending. */
  createdAt: string;
  status: 'sending' | 'failed';
  error?: string;
}

export interface ConversationMessagesState {
  status: 'loading' | 'ready' | 'error';
  error: ApiError | null;
  /** Confirmed messages: unique by id, ordered by (createdAt, id). */
  messages: Message[];
  /** Cursor for the next older page; null when the start of the history is loaded. */
  nextCursor: string | null;
  older: 'idle' | 'loading' | 'error';
  pending: PendingMessage[];
}

export type ConversationMessagesAction =
  | { type: 'reset' }
  | { type: 'loaded'; page: MessagePage }
  | { type: 'loadFailed'; error: ApiError }
  | { type: 'olderStarted' }
  | { type: 'olderLoaded'; page: MessagePage }
  | { type: 'olderFailed' }
  /** Confirmed messages from a send response or a realtime event. */
  | { type: 'received'; messages: Message[] }
  /** The newest page, refetched after (re)joining the realtime channel. */
  | { type: 'latestRefetched'; page: MessagePage }
  | { type: 'sendStarted'; pending: PendingMessage }
  | { type: 'sendRetried'; clientId: string }
  | { type: 'sendFailed'; clientId: string; error: string };

export const initialMessagesState: ConversationMessagesState = {
  status: 'loading',
  error: null,
  messages: [],
  nextCursor: null,
  older: 'idle',
  pending: [],
};

/** A confirmed message replaces the pending one with the same clientId (sent from this tab). */
function withoutConfirmed(pending: PendingMessage[], confirmed: Message[]): PendingMessage[] {
  if (pending.length === 0) return pending;
  const confirmedIds = new Set(confirmed.map((message) => message.clientId));
  return pending.filter((p) => !confirmedIds.has(p.clientId));
}

export function conversationMessagesReducer(
  state: ConversationMessagesState,
  action: ConversationMessagesAction,
): ConversationMessagesState {
  switch (action.type) {
    case 'reset':
      return initialMessagesState;

    case 'loaded':
      // Merge rather than replace: realtime events may already have arrived.
      return {
        ...state,
        status: 'ready',
        error: null,
        messages: mergeMessages(state.messages, action.page.messages),
        nextCursor: action.page.nextCursor,
        pending: withoutConfirmed(state.pending, action.page.messages),
      };

    case 'loadFailed':
      return { ...state, status: 'error', error: action.error };

    case 'olderStarted':
      return { ...state, older: 'loading' };

    case 'olderLoaded':
      return {
        ...state,
        older: 'idle',
        messages: mergeMessages(state.messages, action.page.messages),
        nextCursor: action.page.nextCursor,
      };

    case 'olderFailed':
      return { ...state, older: 'error' };

    case 'received':
      return {
        ...state,
        messages: mergeMessages(state.messages, action.messages),
        pending: withoutConfirmed(state.pending, action.messages),
      };

    case 'latestRefetched': {
      const { page } = action;
      const known = new Set(state.messages.map((message) => message.id));
      // The newest page connects to what we have if it overlaps it, or if it is the whole
      // history. Otherwise more messages were missed than fit on a page: start over from
      // the newest page instead of showing a list with a hole in it.
      const connects = page.nextCursor === null || page.messages.some((message) => known.has(message.id));
      return {
        ...state,
        status: 'ready',
        error: null,
        messages: connects ? mergeMessages(state.messages, page.messages) : page.messages,
        nextCursor: connects && state.status === 'ready' ? state.nextCursor : page.nextCursor,
        pending: withoutConfirmed(state.pending, page.messages),
      };
    }

    case 'sendStarted':
      return { ...state, pending: [...state.pending, action.pending] };

    case 'sendRetried':
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.clientId === action.clientId
            ? { clientId: p.clientId, content: p.content, attachments: p.attachments, createdAt: p.createdAt, status: 'sending' }
            : p,
        ),
      };

    case 'sendFailed':
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.clientId === action.clientId ? { ...p, status: 'failed', error: action.error } : p,
        ),
      };
  }
}
