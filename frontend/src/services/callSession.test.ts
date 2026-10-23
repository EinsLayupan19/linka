import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSignal } from '@linka/shared';
import { FakeMediaStream, FakePeerConnection } from '../test/webrtc';
import {
  CANDIDATE_BATCH_MS,
  LOST_AFTER_MS,
  READY_RETRY_MS,
  RESTART_AFTER_MS,
  startCallSession,
  type CallSession,
  type CallSessionOptions,
} from './callSession';
import type { CallChannel, CallChannelHandlers } from './realtime';

const CALL_ID = '6a1c3e5f-7b9d-4f2a-8c4e-0d2f4a6c8e1b';
const CALLER = '3f2b8c1e-7a4d-4e9b-9c2a-1d5e8f7a6b3c';
const CALLEE = '8e0a2c4d-6f8b-4a1c-9e3d-5f7b9d1f3a5c';

/**
 * An in-memory Realtime channel shared by every session of the call. Messages queue up until
 * flush(), so tests decide what arrives when (including messages that cross).
 */
function createBus() {
  const members: { handlers: CallChannelHandlers; joined: boolean; left: boolean; sent: CallSignal[] }[] = [];
  const queue: { from: (typeof members)[number]; signal: CallSignal }[] = [];
  const join = (_callId: string, handlers: CallChannelHandlers): CallChannel => {
    const member = { handlers, joined: false, left: false, sent: [] as CallSignal[] };
    members.push(member);
    return {
      send: (signal) => {
        if (!member.joined || member.left) return false;
        member.sent.push(signal);
        queue.push({ from: member, signal });
        return true;
      },
      leave: () => {
        member.left = true;
      },
    };
  };
  return {
    join,
    members,
    /** The channel of the n-th session started. */
    member: (n: number) => members[n]!,
    /** The server accepts the n-th session's join. */
    connect(n: number) {
      members[n]!.joined = true;
      members[n]!.handlers.onJoined?.();
    },
    async flush() {
      while (queue.length > 0) {
        const { from, signal } = queue.shift()!;
        // Supabase does not echo a client's own broadcasts.
        for (const member of members) if (member !== from && member.joined && !member.left) member.handlers.onSignal(signal);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  };
}

type Bus = ReturnType<typeof createBus>;

function session(bus: Bus, role: 'caller' | 'callee', overrides: Partial<CallSessionOptions> = {}) {
  const peers: FakePeerConnection[] = [];
  const stream = new FakeMediaStream();
  const options: CallSessionOptions = {
    callId: CALL_ID,
    myUserId: role === 'caller' ? CALLER : CALLEE,
    peerUserId: role === 'caller' ? CALLEE : CALLER,
    role,
    iceServers: [],
    localStream: stream as unknown as MediaStream,
    onRemoteStream: vi.fn(),
    onState: vi.fn(),
    onPeerMuted: vi.fn(),
    onReplaced: vi.fn(),
    joinChannel: bus.join,
    createConnection: (config) => {
      const peer = new FakePeerConnection(config);
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    ...overrides,
  };
  const handle: CallSession = startCallSession(options);
  return { handle, options, peers, stream, peer: () => peers.at(-1)! };
}

/** Both sides' current connections belong together: offer and answer match. */
function expectPaired(caller: ReturnType<typeof session>, callee: ReturnType<typeof session>) {
  expect(callee.peer().remoteDescription?.sdp).toBe(caller.peer().localDescription?.sdp);
  expect(caller.peer().remoteDescription?.sdp).toBe(callee.peer().localDescription?.sdp);
  expect(caller.peer().signalingState).toBe('stable');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('call session signaling', () => {
  it('connects: the callee says ready, the caller offers, the callee answers', async () => {
    const bus = createBus();
    const caller = session(bus, 'caller');
    bus.connect(0); // the caller joins while it still rings: nobody hears its ready
    await bus.flush();
    expect(caller.peers).toHaveLength(0);

    const callee = session(bus, 'callee');
    bus.connect(1);
    await bus.flush();

    expect(caller.peers).toHaveLength(1);
    expect(callee.peers).toHaveLength(1);
    expectPaired(caller, callee);
    expect(bus.member(0).sent.map((s) => s.kind)).toEqual(['ready', 'offer']);
    expect(bus.member(1).sent.map((s) => s.kind)).toEqual(['ready', 'answer']);
  });

  it('batches ICE candidates and delivers them to the matching connection', async () => {
    const bus = createBus();
    const caller = session(bus, 'caller');
    const callee = session(bus, 'callee');
    bus.connect(0);
    bus.connect(1);
    await bus.flush();

    caller.peer().gather('candidate:a');
    caller.peer().gather('candidate:b');
    caller.peer().gather('candidate:c');
    await vi.advanceTimersByTimeAsync(CANDIDATE_BATCH_MS);
    await bus.flush();

    const ice = bus.member(0).sent.filter((s) => s.kind === 'ice');
    expect(ice).toHaveLength(1);
    expect(ice[0]).toMatchObject({ kind: 'ice', candidates: [{ candidate: 'candidate:a' }, { candidate: 'candidate:b' }, { candidate: 'candidate:c' }] });
    expect(callee.peer().addedCandidates).toHaveLength(3);
  });

  it('converges on one connection when both sides join at the same moment (crossing readys)', async () => {
    const bus = createBus();
    const caller = session(bus, 'caller');
    const callee = session(bus, 'callee');
    bus.connect(0);
    bus.connect(1); // both readys are in flight before either arrives
    await bus.flush();
    await vi.advanceTimersByTimeAsync(READY_RETRY_MS * 2);
    await bus.flush();

    expectPaired(caller, callee);
    // Older connections were closed, never left half-open.
    expect(caller.peers.slice(0, -1).every((p) => p.closed)).toBe(true);
    expect(callee.peers.slice(0, -1).every((p) => p.closed)).toBe(true);
  });

  it('a reloaded callee page takes over: the old session is told to stop', async () => {
    const bus = createBus();
    const caller = session(bus, 'caller');
    const oldCallee = session(bus, 'callee');
    bus.connect(0);
    bus.connect(1);
    await bus.flush();

    const newCallee = session(bus, 'callee');
    bus.connect(2);
    await bus.flush();

    expect(oldCallee.options.onReplaced).toHaveBeenCalledTimes(1);
    expect(oldCallee.peer().closed).toBe(true);
    expect(bus.member(1).left).toBe(true);
    expectPaired(caller, newCallee);
    expect(caller.peers[0]!.closed).toBe(true);
  });

  it('a reloaded caller page reconnects with a fresh connection', async () => {
    const bus = createBus();
    const oldCaller = session(bus, 'caller');
    const callee = session(bus, 'callee');
    bus.connect(0);
    bus.connect(1);
    await bus.flush();
    const firstConnection = callee.peer();

    const newCaller = session(bus, 'caller');
    bus.connect(2);
    await bus.flush();

    expect(oldCaller.options.onReplaced).toHaveBeenCalled();
    expect(callee.peer()).not.toBe(firstConnection);
    expect(firstConnection.closed).toBe(true);
    expectPaired(newCaller, callee);
  });

  it('ignores signals from strangers, our own other tabs, other sessions and old connections', async () => {
    const bus = createBus();
    const caller = session(bus, 'caller');
    const callee = session(bus, 'callee');
    bus.connect(0);
    bus.connect(1);
    await bus.flush();
    const connection = (bus.member(0).sent.find((s) => s.kind === 'offer') as Extract<CallSignal, { kind: 'offer' }>).connection;
    const offersBefore = callee.peers.length;
    const deliver = (signal: object) => bus.member(1).handlers.onSignal(signal as CallSignal);
    const base = { callId: CALL_ID, session: 'stranger-session-1' };

    deliver({ kind: 'offer', ...base, from: '11111111-1111-4111-8111-111111111111', to: callee.handle.sessionId, connection: 'conn-zzzzzzzz', sdp: 'evil' });
    deliver({ kind: 'offer', ...base, from: CALLEE, to: callee.handle.sessionId, connection: 'conn-zzzzzzzz', sdp: 'self' });
    deliver({ kind: 'media', ...base, from: CALLER, muted: true }); // not the caller's current session
    deliver({ kind: 'ice', callId: CALL_ID, from: CALLER, session: caller.handle.sessionId, to: 'someone-else-1', connection, candidates: [{ candidate: 'x' }] });
    deliver({ kind: 'ice', callId: CALL_ID, from: CALLER, session: caller.handle.sessionId, to: callee.handle.sessionId, connection: 'old-connection', candidates: [{ candidate: 'y' }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(callee.peers).toHaveLength(offersBefore);
    expect(callee.peer().remoteDescription?.sdp).not.toMatch(/evil|self/);
    expect(callee.peer().addedCandidates).toEqual([]);
    expect(callee.options.onPeerMuted).not.toHaveBeenCalled();
  });

  it('mute disables the microphone track and tells the other side', async () => {
    const bus = createBus();
    const caller = session(bus, 'caller');
    const callee = session(bus, 'callee');
    bus.connect(0);
    bus.connect(1);
    await bus.flush();

    caller.handle.setMuted(true);
    await bus.flush();
    expect(caller.stream.getAudioTracks()[0]!.enabled).toBe(false);
    expect(callee.options.onPeerMuted).toHaveBeenLastCalledWith(true);

    caller.handle.setMuted(false);
    await bus.flush();
    expect(caller.stream.getAudioTracks()[0]!.enabled).toBe(true);
    expect(callee.options.onPeerMuted).toHaveBeenLastCalledWith(false);
  });
});

describe('call session recovery', () => {
  async function connected() {
    const bus = createBus();
    const caller = session(bus, 'caller');
    const callee = session(bus, 'callee');
    bus.connect(0);
    bus.connect(1);
    await bus.flush();
    caller.peer().setState('connected');
    callee.peer().setState('connected');
    return { bus, caller, callee };
  }

  it('reports connected, then reconnecting when the connection drops', async () => {
    const { caller } = await connected();
    expect(caller.options.onState).toHaveBeenLastCalledWith('connected');
    caller.peer().setState('disconnected');
    expect(caller.options.onState).toHaveBeenLastCalledWith('reconnecting');
  });

  it('a failed connection gets an ICE restart on the same connection (no new one)', async () => {
    const { bus, caller, callee } = await connected();
    const peers = [caller.peers.length, callee.peers.length];

    caller.peer().setState('failed');
    await vi.advanceTimersByTimeAsync(0);
    await bus.flush();

    expect(caller.peer().offers.at(-1)).toEqual({ iceRestart: true });
    expect([caller.peers.length, callee.peers.length]).toEqual(peers);
    expectPaired(caller, callee);
  });

  it('a connection that stays disconnected is restarted after a while', async () => {
    const { caller } = await connected();
    caller.peer().setState('disconnected');
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_MS - 1);
    expect(caller.peer().offers.filter((o) => o.iceRestart)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(caller.peer().offers.filter((o) => o.iceRestart)).toHaveLength(1);
  });

  it('the callee asks the caller to renegotiate when its side fails', async () => {
    const { bus, callee } = await connected();
    const readys = () => bus.member(1).sent.filter((s) => s.kind === 'ready').length;
    const before = readys();
    callee.peer().setState('failed');
    expect(readys()).toBe(before + 1);
  });

  it('gives up when not connected again within the limit, and not before', async () => {
    const { caller } = await connected();
    caller.peer().setState('disconnected');
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS - 1);
    expect(caller.options.onState).not.toHaveBeenCalledWith('lost');
    await vi.advanceTimersByTimeAsync(1);
    expect(caller.options.onState).toHaveBeenLastCalledWith('lost');
  });

  it('a recovery in time cancels the give-up', async () => {
    const { caller } = await connected();
    caller.peer().setState('disconnected');
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS / 2);
    caller.peer().setState('connected');
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);
    expect(caller.options.onState).not.toHaveBeenCalledWith('lost');
  });

  it('a callee that never hears from the caller gives up too', async () => {
    const bus = createBus();
    const callee = session(bus, 'callee');
    bus.connect(0);
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);
    expect(callee.options.onState).toHaveBeenLastCalledWith('lost');
    // It kept saying ready meanwhile, in case a message was missed.
    expect(bus.member(0).sent.filter((s) => s.kind === 'ready').length).toBeGreaterThan(1);
  });

  it('close() releases everything and sends nothing more', async () => {
    const { bus, caller } = await connected();
    caller.handle.close();
    const sent = bus.member(0).sent.length;
    caller.peer().gather('candidate:late');
    caller.handle.setMuted(true);
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);

    expect(caller.peer().closed).toBe(true);
    expect(bus.member(0).left).toBe(true);
    expect(bus.member(0).sent).toHaveLength(sent);
    expect(caller.options.onState).not.toHaveBeenCalledWith('lost');
  });
});
