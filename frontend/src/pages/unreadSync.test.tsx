import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationTopic, userTopic, type Message } from '@linka/shared';
import { App } from '../App';
import { CONVERSATION_ID, makeConversation, makeMessage } from '../test/messages';
import {
  announceToList,
  conversationReadUpTo,
  readStateBackend,
  resetPageVisibility,
  scrollAwayFromNewest,
  setPageVisibility,
} from '../test/readState';
import { renderWithAuth } from '../test/render';
import { latestChannel, realtimeChannels, TEST_USER_ID } from '../test/supabaseMock';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

/**
 * The chat list's unread badges must always match what the server will say after a refresh:
 * a message only stops counting once the server has saved the read.
 */
const OTHER_CONVERSATION = '4c6e8a0c-2e4a-4c6e-9a0c-2e4a6c8e0a2c';
const readPath = `/api/conversations/${CONVERSATION_ID}/read`;

const list = () => screen.getByRole('navigation', { name: 'Conversations' });
const rowFor = (name: RegExp) => within(list()).getByRole('link', { name });
/** The 1:1 row with Jonas (a group row may also mention him in its preview). */
const jonasRow = () => within(list()).getAllByRole('link').find((link) => !link.textContent?.includes('Weekend trip'))!;
const leaveConversation = () => fireEvent.click(screen.getByRole('link', { name: 'Back' }));
const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function joinChannel(topic: string) {
  await waitFor(() => expect(realtimeChannels.some((c) => c.topic === topic)).toBe(true));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    latestChannel(topic).join();
  });
}

async function openConversation() {
  renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
  await screen.findByRole('log', { name: 'Messages' });
  await within(list()).findAllByRole('link', { name: /Jonas Lindqvist/ });
}

/** A new message from Jonas reaches the server, the list's channel and the open conversation. */
function receive(api: ReturnType<typeof readStateBackend>, message: Message) {
  api.addMessage(message);
  announceToList(message);
  act(() => latestChannel(conversationTopic(CONVERSATION_ID, 0)).emit('message.created', message));
}

afterEach(() => resetPageVisibility());

describe('unread badges for the open conversation', () => {
  it('counts a message that arrives while the tab is hidden: leaving shows the badge the server has', async () => {
    const earlier = makeMessage({ content: 'Earlier' });
    const api = readStateBackend({ conversations: [conversationReadUpTo(makeConversation(), [earlier], earlier.createdAt)], messages: [earlier] });
    await openConversation();
    await joinChannel(userTopic(TEST_USER_ID));
    await joinChannel(conversationTopic(CONVERSATION_ID, 0));

    setPageVisibility('hidden');
    const late = makeMessage({ content: 'Are you there?' });
    receive(api, late);
    announceToList(late); // the same event twice still counts once
    await pause(900);

    expect(api.callsTo('PUT', readPath)).toHaveLength(0);
    leaveConversation();
    expect(jonasRow()).toHaveTextContent('1 unread');
    expect(api.server.conversations[0]!.unreadCount).toBe(1);
  });

  it('counts a message that arrives while the reader is scrolled up in the history', async () => {
    const earlier = makeMessage({ content: 'Earlier' });
    const api = readStateBackend({ conversations: [conversationReadUpTo(makeConversation(), [earlier], earlier.createdAt)], messages: [earlier] });
    await openConversation();
    await joinChannel(userTopic(TEST_USER_ID));
    await joinChannel(conversationTopic(CONVERSATION_ID, 0));

    scrollAwayFromNewest(screen.getByRole('log', { name: 'Messages' }).parentElement!);
    receive(api, makeMessage({ content: 'New while scrolled up' }));
    await pause(900);

    expect(api.callsTo('PUT', readPath)).toHaveLength(0);
    leaveConversation();
    expect(jonasRow()).toHaveTextContent('1 unread');
  });

  it('keeps the badge when the reader leaves before the read could be saved', async () => {
    const earlier = makeMessage({ content: 'Earlier' });
    const api = readStateBackend({ conversations: [conversationReadUpTo(makeConversation(), [earlier], earlier.createdAt)], messages: [earlier] });
    await openConversation();
    await joinChannel(userTopic(TEST_USER_ID));
    await joinChannel(conversationTopic(CONVERSATION_ID, 0));

    receive(api, makeMessage({ content: 'Just arrived' }));
    leaveConversation(); // well within the 600 ms before a read is sent
    await pause(900);

    expect(api.callsTo('PUT', readPath)).toHaveLength(0);
    expect(jonasRow()).toHaveTextContent('1 unread');
  });

  it('marks a message read when it is seen, without ever showing a badge on the open conversation', async () => {
    const earlier = makeMessage({ content: 'Earlier' });
    const api = readStateBackend({ conversations: [conversationReadUpTo(makeConversation(), [earlier], earlier.createdAt)], messages: [earlier] });
    await openConversation();
    await joinChannel(userTopic(TEST_USER_ID));
    await joinChannel(conversationTopic(CONVERSATION_ID, 0));

    const late = makeMessage({ content: 'Seen right away' });
    receive(api, late);
    expect(jonasRow()).not.toHaveTextContent('unread');

    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });
    expect(api.callsTo('PUT', readPath)[0]!.body).toEqual({ lastReadAt: late.createdAt });
    leaveConversation();
    expect(jonasRow()).not.toHaveTextContent('unread');
  });
});

describe('older list responses after a saved read', () => {
  it('cannot bring back a cleared badge, even after leaving the conversation', async () => {
    const one = makeMessage({ content: 'One' });
    const two = makeMessage({ content: 'Two' });
    const api = readStateBackend({ conversations: [conversationReadUpTo(makeConversation(), [one, two], null)], messages: [one, two] });
    await openConversation();

    // The user channel (re)joins: the list is refetched, and this response is slow. It is a
    // snapshot from before the read below: 2 unread.
    const releaseOldList = api.holdNextList();
    await joinChannel(userTopic(TEST_USER_ID));
    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });
    leaveConversation();

    await act(async () => {
      releaseOldList();
      await Promise.resolve();
    });
    await pause(50);
    expect(jonasRow()).not.toHaveTextContent('unread');

    // A list that has caught up with the saved read ends the protection; new messages still count.
    const fetches = api.callsTo('GET', '/api/conversations').length;
    act(() => latestChannel(userTopic(TEST_USER_ID)).fail('CHANNEL_ERROR'));
    act(() => latestChannel(userTopic(TEST_USER_ID)).join());
    await waitFor(() => expect(api.callsTo('GET', '/api/conversations').length).toBe(fetches + 1));
    await pause(50);
    const three = makeMessage({ content: 'Three' });
    api.addMessage(three);
    announceToList(three);
    expect(jonasRow()).toHaveTextContent('1 unread');
  });

  it('refetches once when an older response also carries a newer message, then shows the server count', async () => {
    const one = makeMessage({ content: 'One' });
    const two = makeMessage({ content: 'Two' });
    const api = readStateBackend({ conversations: [conversationReadUpTo(makeConversation(), [one, two], null)], messages: [one, two] });
    await openConversation();

    // A third message reaches the server; the slow list response will include it, unread.
    api.addMessage(makeMessage({ content: 'Three' }));
    const releaseOldList = api.holdNextList();
    await joinChannel(userTopic(TEST_USER_ID));
    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });
    leaveConversation();
    const fetches = api.callsTo('GET', '/api/conversations').length;

    await act(async () => {
      releaseOldList();
      await Promise.resolve();
    });
    // Read up to "Two" is saved; "Three" is still unread: exactly what the server says.
    await waitFor(() => expect(jonasRow()).toHaveTextContent('1 unread'));
    await pause(100);
    expect(api.callsTo('GET', '/api/conversations').length).toBe(fetches + 1);
  });

  it('does not carry a saved read over to a new membership after being removed and added back', async () => {
    const message = makeMessage({ content: 'Welcome' });
    const group = makeConversation({ type: 'group', name: 'Weekend trip' });
    const api = readStateBackend({ conversations: [conversationReadUpTo(group, [message], null)], messages: [message] });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
    await screen.findByRole('log', { name: 'Messages' });
    await joinChannel(userTopic(TEST_USER_ID));
    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });
    leaveConversation();

    act(() => latestChannel(userTopic(TEST_USER_ID)).emit('conversation.changed', { conversationId: CONVERSATION_ID, change: 'removed' }));
    expect(within(list()).queryByText('Weekend trip')).not.toBeInTheDocument();

    // Added back: a new membership with nothing read yet.
    api.server.conversations = [conversationReadUpTo(group, [message], null)];
    act(() => latestChannel(userTopic(TEST_USER_ID)).emit('conversation.changed', { conversationId: CONVERSATION_ID, change: 'added' }));
    await waitFor(() => expect(rowFor(/Weekend trip/)).toHaveTextContent('1 unread'));
  });
});

describe('switching conversations quickly', () => {
  it('keeps each conversation’s own count when leaving before anything was read', async () => {
    const fromJonas = makeMessage({ content: 'Ping' });
    const fromGroup = makeMessage({ conversationId: OTHER_CONVERSATION, content: 'Tent?' });
    const group = makeConversation({ id: OTHER_CONVERSATION, type: 'group', name: 'Weekend trip' });
    const api = readStateBackend({
      conversations: [
        conversationReadUpTo(makeConversation(), [fromJonas], null),
        { ...conversationReadUpTo(group, [fromGroup], null), unreadCount: 2 },
      ],
      messages: [fromJonas],
    });
    await openConversation();

    fireEvent.click(rowFor(/Weekend trip/)); // before the 600 ms read delay
    await pause(900);
    leaveConversation();

    expect(api.callsTo('PUT', readPath)).toHaveLength(0);
    expect(jonasRow()).toHaveTextContent('1 unread');
    expect(rowFor(/Weekend trip/)).toHaveTextContent('2 unread');
  });
});
