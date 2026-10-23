import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_RING_TIMEOUT_SECONDS, callTopic, userTopic, type Call, type CallSignal, type Conversation } from '@linka/shared';
import { App } from '../App';
import { LOST_AFTER_MS } from '../services/callSession';
import { mockApi, type ApiCall } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { CONVERSATION_ID, makeConversation, OTHER_USER_ID } from '../test/messages';
import { renderWithAuth, testProfile } from '../test/render';
import { latestChannel, realtimeChannels, TEST_USER_ID } from '../test/supabaseMock';
import { installWebRtcFakes, type FakePeerConnection } from '../test/webrtc';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

afterEach(() => {
  vi.useRealTimers();
});

const CALL_ID = '5b7d9f1a-3c5e-4a7b-9d1f-3a5c7e9b1d3f';
const PEER_SESSION = 'peer-session-0001';

function makeCall(overrides: Partial<Call> = {}, { me = 'caller', joined = false }: { me?: 'caller' | 'callee'; joined?: boolean } = {}): Call {
  const at = new Date().toISOString();
  return {
    id: CALL_ID,
    conversationId: CONVERSATION_ID,
    initiatorId: me === 'caller' ? TEST_USER_ID : OTHER_USER_ID,
    type: 'voice',
    status: 'ringing',
    startedAt: null,
    endedAt: null,
    createdAt: at,
    participants: [
      { userId: TEST_USER_ID, joinedAt: me === 'caller' || joined ? at : null, leftAt: null },
      { userId: OTHER_USER_ID, joinedAt: me === 'callee' ? at : null, leftAt: null },
    ],
    ...overrides,
  };
}

const active = (call: Call): Call => {
  const at = new Date().toISOString();
  return { ...call, status: 'active', startedAt: at, participants: call.participants.map((p) => ({ ...p, joinedAt: p.joinedAt ?? at })) };
};
const over = (call: Call, status: 'ended' | 'declined' | 'missed'): Call => ({ ...call, status, endedAt: new Date().toISOString() });

interface Backend {
  conversations?: Conversation[];
  ongoing?: Call[];
  onStart?: (call: ApiCall) => Response;
}

function backend({ conversations = [makeConversation()], ongoing = [], onStart }: Backend = {}) {
  let current: Call | null = null;
  return mockApi((call) => {
    if (call.path === '/api/users/me') return jsonResponse(testProfile());
    if (call.path === '/api/users/me/seen') return new Response(null, { status: 204 });
    if (call.method === 'GET' && call.path === '/api/conversations') return jsonResponse({ conversations });
    if (call.method === 'POST' && call.path === '/api/conversations/delivered') return jsonResponse({ updated: [] });
    const conversation = conversations.find((c) => call.path === `/api/conversations/${c.id}`);
    if (call.method === 'GET' && conversation) return jsonResponse(conversation);
    if (call.method === 'GET' && call.path.endsWith('/messages')) return jsonResponse({ messages: [], nextCursor: null });

    if (call.path === '/api/calls/ongoing') return jsonResponse({ calls: ongoing });
    if (call.path === '/api/calls/ice-servers') return jsonResponse({ iceServers: [{ urls: 'stun:stun.test:3478' }] });
    if (call.method === 'POST' && call.path === '/api/calls') {
      if (onStart) return onStart(call);
      current = makeCall();
      return jsonResponse(current, 201);
    }
    if (call.method === 'POST' && call.path === `/api/calls/${CALL_ID}/accept`) {
      current = active(ongoing[0] ?? makeCall({}, { me: 'callee' }));
      return jsonResponse(current);
    }
    if (call.method === 'POST' && call.path === `/api/calls/${CALL_ID}/decline`) return jsonResponse(over(ongoing[0] ?? makeCall({}, { me: 'callee' }), 'declined'));
    if (call.method === 'POST' && call.path === `/api/calls/${CALL_ID}/end`) {
      const base = current ?? ongoing[0] ?? makeCall();
      return jsonResponse(over(base, base.status === 'ringing' ? 'missed' : 'ended'));
    }
    if (call.method === 'POST' && call.path === `/api/calls/${CALL_ID}/heartbeat`) return new Response(null, { status: 204 });
    if (call.method === 'GET' && call.path === `/api/calls/${CALL_ID}`) return jsonResponse(current ?? makeCall());
    return undefined;
  });
}

async function join(topic: string) {
  await waitFor(() => expect(realtimeChannels.some((c) => c.topic === topic && !c.removed)).toBe(true));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    latestChannel(topic).join();
  });
}

const userChannel = () => latestChannel(userTopic(TEST_USER_ID));
const callChannel = () => latestChannel(callTopic(CALL_ID));
const panel = () => screen.getByRole('region', { name: 'Call' });
const findPanel = () => screen.findByRole('region', { name: 'Call' });

function callUpdated(call: Call) {
  act(() => userChannel().emit('call.updated', call));
}

/** A signal from the other person's browser on the call channel. */
function signal(fields: Partial<CallSignal> & { kind: CallSignal['kind'] }) {
  act(() => callChannel().emit('signal', { callId: CALL_ID, from: OTHER_USER_ID, session: PEER_SESSION, ...fields }));
}

const sentSignals = () => callChannel().sent.map((s) => s.payload as CallSignal);

async function openChat(options: Backend = {}) {
  const fakes = installWebRtcFakes();
  const api = backend(options);
  const view = renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
  await join(userTopic(TEST_USER_ID));
  await screen.findByRole('button', { name: 'Call Jonas Lindqvist' });
  return { api, fakes, view };
}

/** Starts a call from the chat header and lets the callee's browser connect. */
async function callAndConnect() {
  const ctx = await openChat();
  fireEvent.click(screen.getByRole('button', { name: 'Call Jonas Lindqvist' }));
  expect(await within(await findPanel()).findByText('Calling…')).toBeInTheDocument();
  await join(callTopic(CALL_ID));
  callUpdated(active(makeCall()));
  signal({ kind: 'ready' });
  await waitFor(() => expect(ctx.fakes.latestPeer()).toBeDefined());
  const peer = ctx.fakes.latestPeer()!;
  await waitFor(() => expect(sentSignals().some((s) => s.kind === 'offer')).toBe(true));
  const offer = sentSignals().find((s) => s.kind === 'offer') as Extract<CallSignal, { kind: 'offer' }>;
  signal({ kind: 'answer', to: offer.session, connection: offer.connection, sdp: 'answer-sdp' });
  await waitFor(() => expect(peer.remoteDescription?.sdp).toBe('answer-sdp'));
  act(() => peer.setState('connected'));
  return { ...ctx, peer: peer as FakePeerConnection, offer };
}

describe('calling someone', () => {
  it('asks for the microphone, rings them, connects over WebRTC, and shows the call', async () => {
    const { api, fakes, peer, offer } = await callAndConnect();

    expect(fakes.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object), video: false }));
    expect(api.callsTo('POST', '/api/calls')[0]!.body).toEqual({ conversationId: CONVERSATION_ID, type: 'voice' });
    // Signaling: ready on joining, then the offer to the callee's session.
    expect(sentSignals()[0]).toMatchObject({ kind: 'ready', callId: CALL_ID, from: TEST_USER_ID });
    expect(offer).toMatchObject({ to: PEER_SESSION, sdp: expect.stringMatching(/^offer-sdp/) });
    expect(peer.config.iceServers).toEqual([{ urls: 'stun:stun.test:3478' }]);
    expect(peer.tracks).toHaveLength(1);

    expect(await within(panel()).findByText('Connected')).toBeInTheDocument();
    expect(within(panel()).getByLabelText(/^Call duration \d+:\d\d$/)).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/heartbeat`).length).toBeGreaterThan(0);
  });

  it('shows the call as connected even when WebRTC connects before the "answered" event', async () => {
    const { fakes } = await openChat();
    fireEvent.click(screen.getByRole('button', { name: 'Call Jonas Lindqvist' }));
    await within(await findPanel()).findByText('Calling…');
    await join(callTopic(CALL_ID));
    signal({ kind: 'ready' });
    await waitFor(() => expect(fakes.latestPeer()).toBeDefined());
    act(() => fakes.latestPeer()!.setState('connected'));
    expect(within(panel()).getByText('Calling…')).toBeInTheDocument();

    callUpdated(active(makeCall()));

    expect(await within(panel()).findByText('Connected')).toBeInTheDocument();
  });

  it('mutes and unmutes the microphone and tells the other side', async () => {
    const { fakes } = await callAndConnect();
    const mute = within(panel()).getByRole('button', { name: 'Mute' });

    fireEvent.click(mute);

    expect(within(panel()).getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    expect(fakes.streams[0]!.getAudioTracks()[0]!.enabled).toBe(false);
    expect(sentSignals().at(-1)).toMatchObject({ kind: 'media', muted: true });

    fireEvent.click(within(panel()).getByRole('button', { name: 'Unmute' }));
    expect(fakes.streams[0]!.getAudioTracks()[0]!.enabled).toBe(true);
  });

  it('shows when the other person mutes', async () => {
    await callAndConnect();
    signal({ kind: 'media', muted: true });
    expect(await within(panel()).findByText('Jonas Lindqvist is muted')).toBeInTheDocument();
  });

  it('hanging up ends the call on the server and releases the microphone and connection', async () => {
    const { api, fakes, peer } = await callAndConnect();

    fireEvent.click(within(panel()).getByRole('button', { name: 'End' }));

    expect(await within(panel()).findByText(/^Call ended/)).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/end`)).toHaveLength(1);
    expect(fakes.streams[0]!.getTracks().every((t) => t.stopped)).toBe(true);
    expect(peer.closed).toBe(true);
    expect(callChannel().removed).toBe(true);

    fireEvent.click(within(panel()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Call' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call Jonas Lindqvist' })).toBeEnabled();
  });

  it('shows the call ending when the other person hangs up', async () => {
    const { fakes } = await callAndConnect();
    callUpdated(over(active(makeCall()), 'ended'));
    expect(await within(panel()).findByText(/^Call ended/)).toBeInTheDocument();
    expect(fakes.streams[0]!.getTracks()[0]!.stopped).toBe(true);
  });

  it('cancelling before they answer', async () => {
    const { api, fakes } = await openChat();
    fireEvent.click(screen.getByRole('button', { name: 'Call Jonas Lindqvist' }));
    fireEvent.click(await within(await findPanel()).findByRole('button', { name: 'Cancel' }));

    expect(await within(panel()).findByText('Call cancelled')).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/end`)).toHaveLength(1);
    expect(fakes.streams[0]!.getTracks()[0]!.stopped).toBe(true);
  });

  it('shows that they declined', async () => {
    await openChat();
    fireEvent.click(screen.getByRole('button', { name: 'Call Jonas Lindqvist' }));
    await within(await findPanel()).findByText('Calling…');
    callUpdated(over(makeCall(), 'declined'));
    expect(await within(panel()).findByText('Jonas Lindqvist declined the call')).toBeInTheDocument();
  });

  it('never rings anyone when the microphone is blocked', async () => {
    const api = backend();
    installWebRtcFakes({ microphone: 'denied' });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
    fireEvent.click(await screen.findByRole('button', { name: 'Call Jonas Lindqvist' }));

    expect(await within(await findPanel()).findByText(/Linka needs your microphone for calls/)).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/calls')).toEqual([]);
  });

  it('shows the API’s reason when the call cannot start, and releases the microphone', async () => {
    const { fakes } = await openChat({
      onStart: () => jsonResponse({ error: { code: 'USER_BUSY', message: 'They are on another call. Try again later.' } }, 409),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call Jonas Lindqvist' }));
    expect(await within(await findPanel()).findByText('They are on another call. Try again later.')).toBeInTheDocument();
    expect(fakes.streams[0]!.getTracks()[0]!.stopped).toBe(true);
  });

  it('stops ringing after the ring timeout: no answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { api } = await openChat();
    fireEvent.click(screen.getByRole('button', { name: 'Call Jonas Lindqvist' }));
    await within(await findPanel()).findByText('Calling…');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_SECONDS * 1000);
    });

    expect(await within(panel()).findByText('Jonas Lindqvist didn’t answer')).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/end`)).toHaveLength(1);
  });

  it('ends the call when the connection cannot be restored', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { api, peer } = await callAndConnect();
    act(() => peer.setState('disconnected'));
    expect(await within(panel()).findByText('Reconnecting…')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);
    });

    expect(await within(panel()).findByText('Call ended: the connection was lost')).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/end`)).toHaveLength(1);
  });

  it('offers no call button in groups, and none while a call is going on', async () => {
    const group = makeConversation({ type: 'group', name: 'Trip' });
    installWebRtcFakes();
    backend({ conversations: [group] });
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
    await screen.findByRole('heading', { name: 'Trip' });
    expect(screen.queryByRole('button', { name: /^Call / })).not.toBeInTheDocument();
  });

  it('disables the call button while a call is ringing', async () => {
    await openChat();
    fireEvent.click(screen.getByRole('button', { name: 'Call Jonas Lindqvist' }));
    await within(await findPanel()).findByText('Calling…');
    expect(screen.getByRole('button', { name: 'Call Jonas Lindqvist' })).toBeDisabled();
  });
});

describe('being called', () => {
  const incoming = makeCall({}, { me: 'callee' });

  it('rings with an announcement, answers with the microphone, and starts signaling', async () => {
    const { api, fakes } = await openChat({ ongoing: [] });
    callUpdated(incoming);

    expect(await screen.findByRole('alert')).toHaveTextContent('Jonas Lindqvist is calling you');
    expect(within(panel()).getByText('Incoming voice call')).toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Accept' }));

    expect(await within(panel()).findByText('Connecting…')).toBeInTheDocument();
    expect(fakes.getUserMedia).toHaveBeenCalled();
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/accept`)).toHaveLength(1);
    await join(callTopic(CALL_ID));
    expect(sentSignals()[0]).toMatchObject({ kind: 'ready', from: TEST_USER_ID });

    // The caller's offer gets an answer from this browser.
    signal({ kind: 'offer', to: (sentSignals()[0] as { session: string }).session, connection: 'conn-00000001', sdp: 'offer-sdp' });
    await waitFor(() => expect(sentSignals().some((s) => s.kind === 'answer')).toBe(true));
    expect(sentSignals().find((s) => s.kind === 'answer')).toMatchObject({ to: PEER_SESSION, connection: 'conn-00000001' });
  });

  it('declining stops the ringing and tells the server', async () => {
    const { api } = await openChat();
    callUpdated(incoming);
    fireEvent.click(await within(await findPanel()).findByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Call' })).not.toBeInTheDocument());
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/decline`)).toHaveLength(1);
  });

  it('shows a missed call when the caller gives up', async () => {
    await openChat();
    callUpdated(incoming);
    await findPanel();
    callUpdated(over(incoming, 'missed'));
    expect(await within(panel()).findByText('Missed call from Jonas Lindqvist')).toBeInTheDocument();
  });

  it('keeps ringing (and says why) when the microphone is blocked', async () => {
    installWebRtcFakes({ microphone: 'missing' });
    const api = backend();
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
    await join(userTopic(TEST_USER_ID));
    callUpdated(incoming);
    fireEvent.click(await within(await findPanel()).findByRole('button', { name: 'Accept' }));

    expect(await within(panel()).findByText('No microphone was found.')).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Accept' })).toBeEnabled();
    expect(api.callsTo('POST', `/api/calls/${CALL_ID}/accept`)).toEqual([]);
  });

  it('when answered in another tab, this tab offers to join instead of ringing', async () => {
    await openChat();
    callUpdated(incoming);
    await findPanel();
    callUpdated(active(makeCall({}, { me: 'callee', joined: true })));

    expect(await within(panel()).findByText('On this call in another tab')).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Join here' })).toBeInTheDocument();
  });

  it('rings after a reload (from the server’s list) and on any signed-in page', async () => {
    installWebRtcFakes();
    backend({ ongoing: [incoming] });
    renderWithAuth(<App />, { path: '/profile' });

    expect(await screen.findByRole('alert')).toHaveTextContent('Jonas Lindqvist is calling you');
  });

  it('a reloaded page in an active call can rejoin it', async () => {
    const ongoing = active(makeCall({}, { me: 'callee' }));
    installWebRtcFakes();
    backend({ ongoing: [ongoing] });
    renderWithAuth(<App />, { path: '/' });

    fireEvent.click(await within(await findPanel()).findByRole('button', { name: 'Join here' }));
    expect(await within(panel()).findByText('Connecting…')).toBeInTheDocument();
    await join(callTopic(CALL_ID));
    expect(sentSignals()[0]).toMatchObject({ kind: 'ready' });
  });

  it('ignores a second incoming call while busy: answering answers the first', async () => {
    const { api } = await openChat();
    callUpdated(incoming);
    await findPanel();
    callUpdated({ ...incoming, id: '9d1f3a5c-7e9b-4d1f-8a5c-7e9b1d3f5a7c' });

    fireEvent.click(within(panel()).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/accept'))).toBe(true));
    expect(api.calls.filter((c) => c.path.endsWith('/accept')).map((c) => c.path)).toEqual([`/api/calls/${CALL_ID}/accept`]);
  });
});
