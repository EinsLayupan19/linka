import { act, fireEvent } from '@testing-library/react';
import { userTopic, type Conversation, type Message } from '@linka/shared';
import { mockApi, type ApiCall } from './api';
import { jsonResponse } from './fetch';
import { testProfile } from './render';
import { latestChannel, TEST_USER_ID } from './supabaseMock';

/**
 * A fake API that keeps read state like the real server: PUT /read saves the caller's marker
 * (forward only) and recomputes the unread count, and every list response is a snapshot of the
 * server at the moment the request ARRIVED. holdNextList() delays one list response, which is how
 * a slow, older response reaching the browser after a newer read is reproduced.
 */
export function readStateBackend(
  initial: { conversations: Conversation[]; messages: Message[] },
  options: { onRead?: (call: ApiCall, attempt: number) => Response | Promise<Response> | undefined } = {},
) {
  const server = { conversations: structuredClone(initial.conversations), messages: [...initial.messages] };
  let held: Promise<void> | null = null;
  let readAttempts = 0;

  const myLastReadAt = (conversation: Conversation) =>
    conversation.members.find((m) => m.userId === TEST_USER_ID)?.lastReadAt ?? null;
  const unreadAfter = (conversationId: string, lastReadAt: string | null) =>
    server.messages.filter(
      (m) => m.conversationId === conversationId && m.senderId !== TEST_USER_ID && (!lastReadAt || m.createdAt > lastReadAt),
    ).length;

  const api = mockApi((call) => {
    if (call.path === '/api/users/me') return jsonResponse(testProfile());
    if (call.path === '/api/users/me/seen') return new Response(null, { status: 204 });
    if (call.method === 'GET' && call.path === '/api/conversations') {
      const snapshot = structuredClone(server.conversations);
      const wait = held;
      held = null;
      return wait ? wait.then(() => jsonResponse({ conversations: snapshot })) : jsonResponse({ conversations: snapshot });
    }
    if (call.method === 'POST' && call.path === '/api/conversations/delivered') return jsonResponse({ updated: [] });

    const conversation = server.conversations.find((c) => call.path.startsWith(`/api/conversations/${c.id}`));
    if (!conversation) return undefined;
    if (call.method === 'GET' && call.path === `/api/conversations/${conversation.id}`) return jsonResponse(conversation);
    if (call.method === 'GET' && call.path.endsWith('/messages')) {
      return jsonResponse({ messages: server.messages.filter((m) => m.conversationId === conversation.id), nextCursor: null });
    }
    if (call.method === 'PUT' && call.path.endsWith('/read')) {
      readAttempts += 1;
      const custom = options.onRead?.(call, readAttempts);
      if (custom) return custom;
      const { lastReadAt } = call.body as { lastReadAt: string };
      const saved = [myLastReadAt(conversation), lastReadAt].filter(Boolean).sort().at(-1)!;
      server.conversations = server.conversations.map((c) =>
        c.id !== conversation.id
          ? c
          : {
              ...c,
              unreadCount: unreadAfter(c.id, saved),
              members: c.members.map((m) => (m.userId === TEST_USER_ID ? { ...m, lastReadAt: saved, lastDeliveredAt: saved } : m)),
            },
      );
      return jsonResponse({ conversationId: conversation.id, lastReadAt: saved, lastDeliveredAt: saved });
    }
    return undefined;
  });

  return {
    ...api,
    server,
    /** The next GET /api/conversations answers only when the returned function is called. */
    holdNextList(): () => void {
      let release!: () => void;
      held = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
    /** A message from someone else is saved on the server (not yet announced to the browser). */
    addMessage(message: Message) {
      server.messages.push(message);
      server.conversations = server.conversations.map((c) =>
        c.id !== message.conversationId
          ? c
          : { ...c, lastMessage: message, updatedAt: message.createdAt, unreadCount: unreadAfter(c.id, myLastReadAt(c)) },
      );
    },
    readAttempts: () => readAttempts,
  };
}

/** The conversation list's live event for a new message (what the database trigger sends). */
export function announceToList(message: Message) {
  act(() =>
    latestChannel(userTopic(TEST_USER_ID)).emit('conversation.activity', {
      conversationId: message.conversationId,
      lastMessage: message,
    }),
  );
}

/** My 1:1 conversation, read up to `readUpTo` (null: nothing read yet), with a matching unread count. */
export function conversationReadUpTo(base: Conversation, messages: Message[], readUpTo: string | null): Conversation {
  const last = messages.at(-1) ?? null;
  return {
    ...base,
    lastMessage: last,
    updatedAt: last?.createdAt ?? base.updatedAt,
    unreadCount: messages.filter((m) => m.senderId !== TEST_USER_ID && (!readUpTo || m.createdAt > readUpTo)).length,
    members: base.members.map((m) => (m.userId === TEST_USER_ID ? { ...m, lastReadAt: readUpTo } : m)),
  };
}

/** jsdom always reports a visible page; this switches it and tells the app, like a browser would. */
export function setPageVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export function resetPageVisibility() {
  delete (document as { visibilityState?: unknown }).visibilityState;
}

/**
 * jsdom has no layout, so every list counts as "at the bottom". This gives the message list a real
 * height and scrolls it to the top (far from the newest messages), then reports the scroll.
 */
export function scrollAwayFromNewest(scrollContainer: HTMLElement) {
  Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, get: () => 0, set: () => undefined });
  fireEvent.scroll(scrollContainer);
}
