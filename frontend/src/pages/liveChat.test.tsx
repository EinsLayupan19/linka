import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { conversationTopic, liveTopic, userTopic, type Conversation, type Message } from '@linka/shared';
import { App } from '../App';
import { mockApi, type ApiCall } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { CONVERSATION_ID, makeConversation, makeMessage, noMarkers, OTHER_USER_ID } from '../test/messages';
import { renderWithAuth, testProfile } from '../test/render';
import { latestChannel, realtimeChannels, TEST_USER_ID } from '../test/supabaseMock';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const OTHER_CONVERSATION = '4c6e8a0c-2e4a-4c6e-9a0c-2e4a6c8e0a2c';
const conversationPath = `/api/conversations/${CONVERSATION_ID}`;

interface Backend {
  conversations: Conversation[];
  messages?: Message[];
}

/** Fake API: list, details, history, read/delivered markers and "seen" reports. */
function backend(state: Backend) {
  return mockApi((call: ApiCall) => {
    if (call.path === '/api/users/me') return jsonResponse(testProfile());
    if (call.path === '/api/users/me/seen') return new Response(null, { status: 204 });
    if (call.method === 'GET' && call.path === '/api/conversations') return jsonResponse({ conversations: state.conversations });
    if (call.method === 'POST' && call.path === '/api/conversations/delivered') return jsonResponse({ updated: [] });
    const conversation = state.conversations.find((c) => call.path.startsWith(`/api/conversations/${c.id}`));
    if (!conversation) return undefined;
    if (call.method === 'GET' && call.path === `/api/conversations/${conversation.id}`) return jsonResponse(conversation);
    if (call.method === 'GET' && call.path.endsWith('/messages')) {
      return jsonResponse({ messages: conversation.id === CONVERSATION_ID ? (state.messages ?? []) : [], nextCursor: null });
    }
    if (call.method === 'PUT' && call.path.endsWith('/read')) {
      const { lastReadAt } = call.body as { lastReadAt: string };
      return jsonResponse({ conversationId: conversation.id, lastReadAt, lastDeliveredAt: lastReadAt });
    }
    return undefined;
  });
}

async function joinChannel(topic: string) {
  await waitFor(() => expect(realtimeChannels.some((c) => c.topic === topic)).toBe(true));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    latestChannel(topic).join();
  });
}

const list = () => screen.getByRole('navigation', { name: 'Conversations' });
const row = (name: RegExp) => within(list()).getByRole('link', { name });
const userChannel = () => latestChannel(userTopic(TEST_USER_ID));

function activity(message: Message) {
  act(() => userChannel().emit('conversation.activity', { conversationId: message.conversationId, lastMessage: message }));
}

describe('live conversation list', () => {
  const second = makeConversation({
    id: OTHER_CONVERSATION,
    type: 'group',
    name: 'Weekend trip',
    updatedAt: '2026-10-22T07:00:00.000Z',
  });

  async function openList(conversations = [makeConversation(), second]) {
    const api = backend({ conversations });
    renderWithAuth(<App />, { path: '/' });
    await within(await screen.findByRole('navigation', { name: 'Conversations' })).findByText('Weekend trip');
    await joinChannel(userTopic(TEST_USER_ID));
    return api;
  }

  it('shows server unread counts', async () => {
    await openList([makeConversation({ unreadCount: 3 }), { ...second, unreadCount: 120 }]);
    expect(row(/Jonas Lindqvist/)).toHaveTextContent('3 unread');
    expect(row(/Weekend trip/)).toHaveTextContent('99+');
  });

  it('updates the preview, order and unread count from the user channel, once per message', async () => {
    await openList();
    const incoming = makeMessage({ conversationId: OTHER_CONVERSATION, content: 'Who brings the tent?' });

    activity(incoming);
    activity(incoming); // duplicate delivery

    const links = within(list()).getAllByRole('link');
    expect(links[0]).toHaveTextContent('Weekend trip');
    expect(row(/Weekend trip/)).toHaveTextContent('Who brings the tent?');
    expect(row(/Weekend trip/)).toHaveTextContent('1 unread');
  });

  it('never counts my own messages as unread (e.g. sent from another tab)', async () => {
    await openList();
    activity(makeMessage({ senderId: TEST_USER_ID, content: 'Sent elsewhere' }));
    expect(row(/Jonas Lindqvist/)).toHaveTextContent('You: Sent elsewhere');
    expect(row(/Jonas Lindqvist/)).not.toHaveTextContent('unread');
  });

  it('clears the unread count when the conversation is read in another tab', async () => {
    const last = makeMessage({ content: 'Unread one' });
    await openList([makeConversation({ lastMessage: last, unreadCount: 1 }), second]);

    act(() => userChannel().emit('conversation.read', { conversationId: CONVERSATION_ID, lastReadAt: last.createdAt }));
    expect(row(/Jonas Lindqvist/)).not.toHaveTextContent('unread');
  });

  it('removes a conversation the user was removed from, and refetches for new ones', async () => {
    const api = await openList();
    act(() => userChannel().emit('conversation.changed', { conversationId: OTHER_CONVERSATION, change: 'removed' }));
    expect(within(list()).queryByText('Weekend trip')).not.toBeInTheDocument();

    const fetches = api.callsTo('GET', '/api/conversations').length;
    act(() => userChannel().emit('conversation.changed', { conversationId: OTHER_CONVERSATION, change: 'added' }));
    await waitFor(() => expect(api.callsTo('GET', '/api/conversations').length).toBe(fetches + 1));
  });

  it('ignores malformed list events', async () => {
    await openList();
    act(() => userChannel().emit('conversation.activity', { conversationId: OTHER_CONVERSATION, lastMessage: { content: 'fake' } }));
    expect(within(list()).queryByText('fake')).not.toBeInTheDocument();
  });

  it('refetches the authoritative list after reconnecting', async () => {
    const api = await openList();
    const fetches = api.callsTo('GET', '/api/conversations').length;

    act(() => userChannel().fail('CHANNEL_ERROR'));
    expect(within(screen.getByRole('complementary')).getByRole('status')).toHaveTextContent('Reconnecting…');
    act(() => userChannel().join());

    await waitFor(() => expect(api.callsTo('GET', '/api/conversations').length).toBe(fetches + 1));
  });

  it('reports delivery for the newest messages it received, in one batch', async () => {
    const fromJonas = makeMessage({ content: 'Hi' });
    const fromGroup = makeMessage({ conversationId: OTHER_CONVERSATION, content: 'Hey' });
    const api = await openList([makeConversation({ lastMessage: fromJonas }), { ...second, lastMessage: fromGroup }]);

    await waitFor(() => expect(api.callsTo('POST', '/api/conversations/delivered')).toHaveLength(1), { timeout: 3000 });
    expect(api.callsTo('POST', '/api/conversations/delivered')[0]!.body).toEqual({
      conversations: [
        { conversationId: CONVERSATION_ID, lastDeliveredAt: fromJonas.createdAt },
        { conversationId: OTHER_CONVERSATION, lastDeliveredAt: fromGroup.createdAt },
      ],
    });
  });
});

describe('opening a conversation', () => {
  it('marks it read up to the newest message and clears its unread count', async () => {
    const messages = [makeMessage({ content: 'One' }), makeMessage({ content: 'Two' })];
    const conversation = makeConversation({ lastMessage: messages[1]!, unreadCount: 2 });
    const api = backend({ conversations: [conversation], messages });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });

    await waitFor(() => expect(api.callsTo('PUT', `${conversationPath}/read`)).toHaveLength(1), { timeout: 3000 });
    expect(api.callsTo('PUT', `${conversationPath}/read`)[0]!.body).toEqual({ lastReadAt: messages[1]!.createdAt });
    await waitFor(() => expect(row(/Jonas Lindqvist/)).not.toHaveTextContent('unread'));
  });

  it('does not mark anything read when there is nothing new from others', async () => {
    const mine = makeMessage({ senderId: TEST_USER_ID, content: 'Mine' });
    const api = backend({ conversations: [makeConversation({ lastMessage: mine })], messages: [mine] });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });

    await screen.findByText('Mine');
    await new Promise((r) => setTimeout(r, 900));
    expect(api.callsTo('PUT', `${conversationPath}/read`)).toHaveLength(0);
  });
});

describe('read receipts', () => {
  async function openWithMine(conversation: Conversation, mine: Message) {
    backend({ conversations: [conversation], messages: [mine] });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
    await screen.findByRole('log', { name: 'Messages' });
    await joinChannel(conversationTopic(CONVERSATION_ID));
  }

  it('goes from Sent to Delivered to Read in 1:1 as the other person’s markers move', async () => {
    const mine = makeMessage({ senderId: TEST_USER_ID, content: 'Did you get this?' });
    await openWithMine(makeConversation(), mine);
    expect(await screen.findByLabelText('Message status: Sent')).toBeInTheDocument();

    const channel = latestChannel(conversationTopic(CONVERSATION_ID));
    act(() => channel.emit('receipt.updated', { conversationId: CONVERSATION_ID, userId: OTHER_USER_ID, lastDeliveredAt: mine.createdAt, lastReadAt: null }));
    expect(screen.getByLabelText('Message status: Delivered')).toBeInTheDocument();

    act(() => channel.emit('receipt.updated', { conversationId: CONVERSATION_ID, userId: OTHER_USER_ID, lastDeliveredAt: mine.createdAt, lastReadAt: mine.createdAt }));
    expect(screen.getByLabelText('Message status: Read')).toBeInTheDocument();
  });

  it('shows how many group members read my latest message', async () => {
    const mine = makeMessage({ senderId: TEST_USER_ID, content: 'Plan?' });
    const member = (userId: string, name: string, lastReadAt: string | null) => ({
      userId, role: 'member' as const, joinedAt: '2026-10-22T08:00:00.000Z', username: name, displayName: name, avatarUrl: null, ...noMarkers, lastReadAt,
    });
    const group = makeConversation({
      type: 'group',
      name: 'Weekend trip',
      members: [
        member(TEST_USER_ID, 'maya', null),
        member(OTHER_USER_ID, 'jonas', mine.createdAt),
        member('5d7f9b1d-3f5b-4d7f-9b1d-3f5b7d9f1b3d', 'maria', mine.createdAt),
        member('9f1b3d5f-7b9d-4f1b-8d5f-7b9d1f3b5d7f', 'ana', null),
      ],
    });
    await openWithMine(group, mine);
    expect(await screen.findByLabelText('Message status: Read by 2')).toBeInTheDocument();
  });
});

describe('typing and presence in the open conversation', () => {
  async function openConversation(conversation = makeConversation()) {
    backend({ conversations: [conversation], messages: [makeMessage()] });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
    await screen.findByRole('log', { name: 'Messages' });
    await joinChannel(liveTopic(CONVERSATION_ID));
    return latestChannel(liveTopic(CONVERSATION_ID));
  }

  it('shows "Jonas Lindqvist is typing…" and clears it when they stop', async () => {
    const live = await openConversation();
    act(() => live.emit('typing', { conversationId: CONVERSATION_ID, userId: OTHER_USER_ID, typing: true }));
    expect(screen.getByText('Jonas Lindqvist is typing…')).toBeInTheDocument();

    act(() => live.emit('typing', { conversationId: CONVERSATION_ID, userId: OTHER_USER_ID, typing: false }));
    expect(screen.queryByText(/is typing/)).not.toBeInTheDocument();
  });

  it('shows Online while the other person has the conversation open, Last seen otherwise', async () => {
    const lastSeen = new Date(Date.now() - 5 * 60_000).toISOString();
    const conversation = makeConversation();
    conversation.members[1] = { ...conversation.members[1]!, lastSeenAt: lastSeen };
    const live = await openConversation(conversation);

    expect(await screen.findByText('Last seen 5 min ago')).toBeInTheDocument();
    act(() => live.setPresence({ [OTHER_USER_ID]: [{ userId: OTHER_USER_ID }] }));
    expect(screen.getByText('Online')).toBeInTheDocument();
    act(() => live.setPresence({}));
    expect(screen.getByText('Last seen 5 min ago')).toBeInTheDocument();
  });
});
