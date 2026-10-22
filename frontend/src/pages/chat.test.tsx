import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { conversationTopic, type Conversation, type Message } from '@linka/shared';
import { App } from '../App';
import { mockApi, type ApiCall } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { CONVERSATION_ID, makeConversation, makeMessage, OTHER_USER_ID } from '../test/messages';
import { renderWithAuth, testProfile } from '../test/render';
import { latestChannel, realtimeChannels, TEST_USER_ID } from '../test/supabaseMock';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const conversationPath = `/api/conversations/${CONVERSATION_ID}`;
const messagesPath = `${conversationPath}/messages`;
const topic = conversationTopic(CONVERSATION_ID);
const currentPath = () => screen.getByTestId('current-path').textContent;

interface Backend {
  conversations?: Conversation[];
  /** Pages by cursor ("" = newest). */
  pages?: Record<string, { messages: Message[]; nextCursor: string | null }>;
  onSend?: (call: ApiCall) => Response | Promise<Response>;
  conversationStatus?: number;
}

/** The fake API for these tests. Profile, list, details, history and sending. */
function backend({ conversations = [makeConversation()], pages = { '': { messages: [], nextCursor: null } }, onSend, conversationStatus = 200 }: Backend = {}) {
  return mockApi((call) => {
    if (call.path === '/api/users/me') return jsonResponse(testProfile());
    if (call.method === 'GET' && call.path === '/api/conversations') return jsonResponse({ conversations });
    if (call.method === 'GET' && call.path === conversationPath) {
      return conversationStatus === 200
        ? jsonResponse(conversations[0])
        : jsonResponse({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found.' } }, conversationStatus);
    }
    if (call.method === 'GET' && call.path === messagesPath) {
      if (conversationStatus !== 200) {
        return jsonResponse({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found.' } }, conversationStatus);
      }
      return jsonResponse(pages[call.query.get('before') ?? ''] ?? { messages: [], nextCursor: null });
    }
    if (call.method === 'POST' && call.path === messagesPath && onSend) return onSend(call);
    return undefined;
  });
}

/** Echoes a sent message back like the API does. */
function sentMessage(call: ApiCall, extra: Partial<Message> = {}): Message {
  const body = call.body as { content: string; clientId: string };
  return makeMessage({ senderId: TEST_USER_ID, content: body.content, clientId: body.clientId, ...extra });
}

async function openConversation(api: Backend = {}) {
  const calls = backend(api);
  renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
  await screen.findByRole('textbox', { name: 'Message' });
  return calls;
}

const messageLog = () => screen.getByRole('log', { name: 'Messages' });
const findMessageLog = () => screen.findByRole('log', { name: 'Messages' });

function typeAndSend(text: string) {
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** Waits for the channel to be opened, then joins it like Supabase would. */
async function joinRealtime() {
  await waitFor(() => expect(realtimeChannels.some((c) => c.topic === topic)).toBe(true));
  await act(async () => {
    await Promise.resolve();
    latestChannel(topic).join();
  });
}

describe('conversation list', () => {
  it('shows conversations with title, preview and time', async () => {
    const last = makeMessage({ senderId: TEST_USER_ID, content: 'See you at 6' });
    const group = makeConversation({ id: '2b4d6f8a-0c2e-4a6b-8d0f-2a4c6e8a0b2d', type: 'group', name: 'Weekend trip', lastMessage: null });
    backend({ conversations: [makeConversation({ lastMessage: last }), group] });
    renderWithAuth(<App />, { path: '/' });

    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    expect(await within(nav).findByText('Jonas Lindqvist')).toBeInTheDocument();
    expect(within(nav).getByText('You: See you at 6')).toBeInTheDocument();
    expect(within(nav).getByText('Weekend trip')).toBeInTheDocument();
    expect(within(nav).getByText('No messages yet')).toBeInTheDocument();
  });

  it('has an empty state', async () => {
    backend({ conversations: [] });
    renderWithAuth(<App />, { path: '/' });
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  it('shows an error with retry, and recovers', async () => {
    let fail = true;
    mockApi((call) => {
      if (call.path === '/api/users/me') return jsonResponse(testProfile());
      if (call.path === '/api/conversations') {
        return fail ? Promise.reject(new TypeError('Failed to fetch')) : jsonResponse({ conversations: [makeConversation()] });
      }
      return undefined;
    });
    renderWithAuth(<App />, { path: '/' });

    expect(await screen.findByText(/Could not load your conversations/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Jonas Lindqvist')).toBeInTheDocument();
  });

  it('opens a conversation when selected', async () => {
    backend();
    renderWithAuth(<App />, { path: '/' });

    fireEvent.click(await screen.findByRole('link', { name: /Jonas Lindqvist/ }));
    expect(currentPath()).toBe(`/conversations/${CONVERSATION_ID}`);
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });
});

describe('conversation view', () => {
  it('loads the newest messages with the access token', async () => {
    const history = [makeMessage({ content: 'Hi Maya' }), makeMessage({ senderId: TEST_USER_ID, content: 'Hi Jonas' })];
    const api = await openConversation({ pages: { '': { messages: history, nextCursor: null } } });

    expect(within(await findMessageLog()).getByText('Hi Maya')).toBeInTheDocument();
    expect(within(messageLog()).getByText('Hi Jonas')).toBeInTheDocument();
    expect(api.callsTo('GET', messagesPath)[0]?.authorization).toBe('Bearer test-access-token');
  });

  it('shows an empty state', async () => {
    await openConversation();
    expect(await screen.findByText('Say hello to start the conversation.')).toBeInTheDocument();
  });

  it('loads earlier messages with the cursor', async () => {
    const older = makeMessage({ content: 'From last week', createdAt: '2026-10-15T09:00:00.000Z' });
    const newest = makeMessage({ content: 'Today' });
    const api = await openConversation({
      pages: { '': { messages: [newest], nextCursor: 'cursor-1' }, 'cursor-1': { messages: [older], nextCursor: null } },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));

    expect(await within(messageLog()).findByText('From last week')).toBeInTheDocument();
    expect(api.callsTo('GET', messagesPath).some((c) => c.query.get('before') === 'cursor-1')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();
  });

  it('shows "not found" for conversations the user cannot access', async () => {
    backend({ conversationStatus: 404 });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
    expect(await screen.findByRole('heading', { name: 'Conversation not found' })).toBeInTheDocument();
    // Never tries to join the conversation's channels without access.
    expect(realtimeChannels.filter((c) => !c.topic.startsWith('user:'))).toHaveLength(0);
  });
});

describe('sending', () => {
  it('sends the text as typed with a clientId, shows it, and updates the list preview', async () => {
    const api = await openConversation({ onSend: (call) => jsonResponse(sentMessage(call), 201) });

    typeAndSend('  Lunch?  ');

    expect(within(await findMessageLog()).getByText('Lunch?')).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo('POST', messagesPath)).toHaveLength(1));
    const body = api.callsTo('POST', messagesPath)[0]!.body as { content: string; clientId: string };
    expect(body.content).toBe('  Lunch?  ');
    expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty('senderId');

    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(await within(nav).findByText('You: Lunch?')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  it('shows "Sending…" until the server confirms', async () => {
    let confirm: (response: Response) => void = () => {};
    await openConversation({ onSend: () => new Promise<Response>((resolve) => (confirm = resolve)) });

    typeAndSend('Pending one');
    expect(await screen.findByText('Sending…')).toBeInTheDocument();

    const api = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const post = api.find(([url, init]) => init?.method === 'POST' && String(url).endsWith(messagesPath))!;
    await act(async () => confirm(jsonResponse(sentMessage({ body: JSON.parse(String(post[1].body)) } as ApiCall), 201)));
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument());
    expect(within(messageLog()).getByText('Pending one')).toBeInTheDocument();
  });

  it('marks a failed send and retries with the same clientId', async () => {
    let attempts = 0;
    const api = await openConversation({
      onSend: (call) => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new TypeError('Failed to fetch')) : jsonResponse(sentMessage(call), 201);
      },
    });

    typeAndSend('Try again please');
    expect(await screen.findByText('Not sent.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Not sent.')).not.toBeInTheDocument());

    const [first, second] = api.callsTo('POST', messagesPath).map((c) => (c.body as { clientId: string }).clientId);
    expect(second).toBe(first);
    expect(within(messageLog()).getAllByText('Try again please')).toHaveLength(1);
  });

  it('does not send whitespace-only text and explains over-long text', async () => {
    const api = await openConversation({ onSend: (call) => jsonResponse(sentMessage(call), 201) });
    const input = screen.getByRole('textbox', { name: 'Message' });

    fireEvent.change(input, { target: { value: '   \n ' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'x'.repeat(4001) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Messages can be at most 4000 characters.');
    expect(api.callsTo('POST', messagesPath)).toHaveLength(0);
  });

  it('adds a new line with Shift+Enter instead of sending', async () => {
    const api = await openConversation({ onSend: (call) => jsonResponse(sentMessage(call), 201) });
    const input = screen.getByRole('textbox', { name: 'Message' });

    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.callsTo('POST', messagesPath)).toHaveLength(0);
  });
});

describe('realtime', () => {
  it('uses one user channel plus this conversation’s two channels, and leaves the conversation’s on navigation', async () => {
    await openConversation();
    await joinRealtime();

    expect(realtimeChannels.map((c) => c.topic).sort()).toEqual(
      [`user:${TEST_USER_ID}`, topic, `live:${CONVERSATION_ID}`].sort(),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Chats' }));
    await waitFor(() => expect(latestChannel(topic).removed).toBe(true));
    expect(latestChannel(`live:${CONVERSATION_ID}`).removed).toBe(true);
    expect(latestChannel(`user:${TEST_USER_ID}`).removed).toBe(false);
  });

  it('shows new messages as they arrive, once each', async () => {
    await openConversation();
    await joinRealtime();
    const incoming = makeMessage({ content: 'Live from Jonas' });

    act(() => latestChannel(topic).emit('message.created', incoming));
    act(() => latestChannel(topic).emit('message.created', incoming)); // duplicate delivery

    expect(within(messageLog()).getAllByText('Live from Jonas')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(within(nav).getByText('Live from Jonas')).toBeInTheDocument();
  });

  it('shows the user’s own message once when its realtime echo arrives before the API response', async () => {
    let respond: (r: Response) => void = () => {};
    let lastCall: ApiCall | undefined;
    await openConversation({
      onSend: (call) => {
        lastCall = call;
        return new Promise<Response>((resolve) => (respond = resolve));
      },
    });
    await joinRealtime();

    typeAndSend('Echo test');
    await waitFor(() => expect(lastCall).toBeDefined());
    const stored = sentMessage(lastCall!);

    act(() => latestChannel(topic).emit('message.created', stored)); // echo first
    await act(async () => respond(jsonResponse(stored, 201))); // then the response

    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument());
    expect(within(messageLog()).getAllByText('Echo test')).toHaveLength(1);
  });

  it('says when it is reconnecting, then catches up on missed messages', async () => {
    const before = makeMessage({ content: 'Before the drop' });
    const missed = makeMessage({ senderId: OTHER_USER_ID, content: 'Sent while you were away' });
    const pages = { '': { messages: [before], nextCursor: null } };
    const api = await openConversation({ pages });
    await joinRealtime();
    const fetchesBefore = api.callsTo('GET', messagesPath).length;

    act(() => latestChannel(topic).fail('CHANNEL_ERROR'));
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting… You can still send messages.');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();

    pages[''] = { messages: [before, missed], nextCursor: null };
    act(() => latestChannel(topic).join());

    expect(await within(messageLog()).findByText('Sent while you were away')).toBeInTheDocument();
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    expect(api.callsTo('GET', messagesPath).length).toBe(fetchesBefore + 1);
    expect(within(messageLog()).getAllByText('Before the drop')).toHaveLength(1);
  });
});

describe('new chat', () => {
  it('finds people by username and opens the conversation', async () => {
    const api = mockApi((call) => {
      if (call.path === '/api/users/me') return jsonResponse(testProfile());
      if (call.method === 'GET' && call.path === '/api/conversations') return jsonResponse({ conversations: [] });
      if (call.path === '/api/users/search') {
        return jsonResponse({ users: [{ id: OTHER_USER_ID, username: 'jonas', displayName: 'Jonas Lindqvist', avatarPath: null }] });
      }
      if (call.method === 'POST' && call.path === '/api/conversations') return jsonResponse(makeConversation(), 201);
      if (call.path === conversationPath) return jsonResponse(makeConversation());
      if (call.path === messagesPath) return jsonResponse({ messages: [], nextCursor: null });
      return undefined;
    });
    renderWithAuth(<App />, { path: '/conversations/new' });

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'Jo' } });
    fireEvent.click(await screen.findByRole('button', { name: /Jonas Lindqvist/ }));

    await waitFor(() => expect(currentPath()).toBe(`/conversations/${CONVERSATION_ID}`));
    expect(api.callsTo('GET', '/api/users/search')[0]?.query.get('q')).toBe('Jo');
    expect(api.callsTo('POST', '/api/conversations')[0]?.body).toEqual({ type: 'direct', userId: OTHER_USER_ID });
  });

  it('waits for at least 2 characters before searching', async () => {
    const api = backend({ conversations: [] });
    renderWithAuth(<App />, { path: '/conversations/new' });

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'j' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(api.callsTo('GET', '/api/users/search')).toHaveLength(0);
  });
});
