import { CALL_SIGNAL_MAX_CANDIDATES, type CallSignal, type IceCandidate } from '@linka/shared';
import { joinCallChannel, type CallChannel, type CallChannelHandlers } from './realtime';
import { createPeer, type Peer, type PeerOptions, type PeerState } from './webrtc';

/**
 * Connects this browser tab to the other person in a call: WebRTC (services/webrtc.ts) plus
 * signaling over the call's private Realtime channel. No React, no API calls.
 *
 * Protocol (see callSignalSchema):
 * - Every tab has a random session id. On every (re)join of the channel a tab says `ready`.
 * - The caller answers a `ready` from the callee by (re)negotiating: a fresh connection (with a
 *   new connection id) and an offer. Answers and candidates for an older connection are ignored,
 *   so crossing messages can never mix two connections. The callee answers the caller's `ready` with its own `ready` when it is not connected
 *   (so a reloaded caller page gets an offer going again).
 * - Messages from the other person's previous session are ignored; that session gets `bye`, which
 *   is how a call moves to another tab or survives a reload without two connections fighting.
 * - ICE candidates are batched (CANDIDATE_BATCH_MS) to stay under Realtime's message limits.
 * - When the connection drops, the caller tries an ICE restart (the callee asks for one); if it
 *   is not connected again within LOST_AFTER_MS, the session reports `lost`.
 */

export type CallConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'lost';

export const CANDIDATE_BATCH_MS = 100;
/** Not (re)connected for this long: give up. */
export const LOST_AFTER_MS = 30_000;
/** Still reconnecting after this long: try an ICE restart. */
export const RESTART_AFTER_MS = 6_000;
/** The callee repeats `ready` this often until the caller's offer arrives. */
export const READY_RETRY_MS = 4_000;
/** The caller does not start over for a repeated `ready` while its last offer is this fresh. */
export const NEGOTIATION_GRACE_MS = 2_000;

export interface CallSessionOptions {
  callId: string;
  myUserId: string;
  peerUserId: string;
  role: 'caller' | 'callee';
  iceServers: RTCIceServer[];
  localStream: MediaStream;
  onRemoteStream: (stream: MediaStream) => void;
  onState: (state: CallConnectionState) => void;
  onPeerMuted: (muted: boolean) => void;
  /** This call continues in another tab (or a reloaded page) of the same user. */
  onReplaced: () => void;
  /** For tests. */
  sessionId?: string;
  joinChannel?: (callId: string, handlers: CallChannelHandlers) => CallChannel;
  createConnection?: PeerOptions['createConnection'];
}

export interface CallSession {
  readonly sessionId: string;
  setMuted: (muted: boolean) => void;
  close: () => void;
}

export function startCallSession(options: CallSessionOptions): CallSession {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const join = options.joinChannel ?? joinCallChannel;
  let peerSession: string | null = null;
  let peer: Peer | null = null;
  let connectionId = '';
  let lastOfferAt = -Infinity;
  let muted = false;
  let closed = false;
  let state: CallConnectionState = 'connecting';
  let candidates: IceCandidate[] = [];
  const timers = { candidates: undefined as Timer, lost: undefined as Timer, restart: undefined as Timer, ready: undefined as Timer };

  const base = () => ({ callId: options.callId, from: options.myUserId, session: sessionId });

  function setState(next: CallConnectionState) {
    if (closed || next === state) return;
    state = next;
    options.onState(next);
  }

  /** Starts the give-up timer unless it is already running. */
  function armLost() {
    timers.lost ??= setTimeout(() => {
      timers.lost = undefined;
      if (!closed && peer?.state !== 'connected') setState('lost');
    }, LOST_AFTER_MS);
  }

  function flushCandidates() {
    clearTimeout(timers.candidates);
    timers.candidates = undefined;
    if (!peerSession || candidates.length === 0) return;
    for (let i = 0; i < candidates.length; i += CALL_SIGNAL_MAX_CANDIDATES) {
      channel.send({
        kind: 'ice',
        ...base(),
        to: peerSession,
        connection: connectionId,
        candidates: candidates.slice(i, i + CALL_SIGNAL_MAX_CANDIDATES),
      });
    }
    candidates = [];
  }

  function onPeerState(next: PeerState) {
    if (closed) return;
    if (next === 'connected') {
      clearTimeout(timers.lost);
      timers.lost = undefined;
      clearTimeout(timers.restart);
      timers.restart = undefined;
      setState('connected');
      return;
    }
    if (next === 'connecting') return;
    // Dropped (reconnecting) or failed: the browser may recover on its own; if not, renegotiate.
    setState('reconnecting');
    armLost();
    const restart = () => {
      timers.restart = undefined;
      if (closed || peer?.state === 'connected') return;
      if (options.role === 'caller') void peer?.offer({ iceRestart: true }).catch(() => undefined);
      else sendReady(); // asks the caller to renegotiate
    };
    if (next === 'failed') restart();
    else timers.restart ??= setTimeout(restart, RESTART_AFTER_MS);
  }

  /** A fresh connection to the other person's current session. */
  function newPeer(id: string = crypto.randomUUID()): Peer {
    peer?.close();
    candidates = [];
    connectionId = id;
    peer = createPeer({
      iceServers: options.iceServers,
      localStream: options.localStream,
      sendDescription: (kind, sdp) => {
        if (peerSession) channel.send({ kind, ...base(), to: peerSession, connection: id, sdp });
      },
      sendCandidate: (candidate) => {
        candidates.push(candidate);
        if (candidates.length >= CALL_SIGNAL_MAX_CANDIDATES) flushCandidates();
        else timers.candidates ??= setTimeout(flushCandidates, CANDIDATE_BATCH_MS);
      },
      onRemoteStream: options.onRemoteStream,
      onState: onPeerState,
      ...(options.createConnection ? { createConnection: options.createConnection } : {}),
    });
    armLost();
    return peer;
  }

  function sendReady() {
    channel.send({ kind: 'ready', ...base() });
    if (options.role === 'callee') {
      // Until the caller's offer arrives, keep saying ready (a broadcast can be missed).
      clearTimeout(timers.ready);
      timers.ready = setTimeout(() => {
        if (!closed && (!peer || peer.state !== 'connected')) sendReady();
      }, READY_RETRY_MS);
    }
  }

  /** The other person's tab changed: forget the old one (and tell it to stop). */
  function adopt(session: string) {
    if (peerSession === session) return false;
    if (peerSession) channel.send({ kind: 'bye', ...base(), to: peerSession });
    peerSession = session;
    return true;
  }

  async function handle(signal: CallSignal) {
    if (closed) return;
    // Only the other person counts (not strangers, not our own other tabs).
    if (signal.from !== options.peerUserId) return;
    if ('to' in signal && signal.to !== sessionId) return;

    switch (signal.kind) {
      case 'ready': {
        const changed = adopt(signal.session);
        // Tell the (new) other side whether we are muted.
        if (changed && muted) channel.send({ kind: 'media', ...base(), muted });
        const connected = peer?.state === 'connected';
        if (options.role === 'caller') {
          // A repeated ready while our offer is still on its way is not a reason to start over.
          const inFlight = performance.now() - lastOfferAt < NEGOTIATION_GRACE_MS;
          if (changed || (!connected && !inFlight)) {
            lastOfferAt = performance.now();
            await newPeer().offer().catch(() => undefined);
          }
        } else if (changed || !connected) {
          channel.send({ kind: 'ready', ...base() });
        }
        return;
      }
      case 'offer': {
        if (options.role !== 'callee') return;
        const changed = adopt(signal.session);
        clearTimeout(timers.ready);
        // A new caller session or a new connection starts over; an ICE restart offer for the
        // connection we have is applied to it.
        const target = changed || !peer || signal.connection !== connectionId ? newPeer(signal.connection) : peer;
        await target.acceptOffer(signal.sdp).catch(() => undefined);
        return;
      }
      case 'answer':
        if (options.role === 'caller' && signal.session === peerSession && signal.connection === connectionId) {
          await peer?.acceptAnswer(signal.sdp).catch(() => undefined);
        }
        return;
      case 'ice':
        if (signal.session === peerSession && signal.connection === connectionId) await peer?.addRemoteCandidates(signal.candidates);
        return;
      case 'media':
        if (signal.session === peerSession) options.onPeerMuted(signal.muted);
        return;
      case 'bye':
        // Our session was replaced by another tab of ours.
        close();
        options.onReplaced();
        return;
    }
  }

  const channel = join(options.callId, {
    onSignal: (signal) => void handle(signal),
    // Every (re)join: say we are here. Signals sent while disconnected are not replayed.
    onJoined: sendReady,
  });
  if (options.role === 'callee') armLost(); // the caller should make contact soon after we answered

  function close() {
    if (closed) return;
    flushCandidates();
    closed = true;
    for (const timer of Object.values(timers)) clearTimeout(timer);
    peer?.close();
    peer = null;
    channel.leave();
  }

  return {
    sessionId,
    setMuted(next) {
      muted = next;
      for (const track of options.localStream.getAudioTracks()) track.enabled = !next;
      if (!closed) channel.send({ kind: 'media', ...base(), muted: next });
    },
    close,
  };
}

type Timer = ReturnType<typeof setTimeout> | undefined;
