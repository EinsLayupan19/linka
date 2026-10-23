import type { IceCandidate } from '@linka/shared';

/**
 * One WebRTC peer connection for a 1:1 call, with no knowledge of React, Linka's API or how
 * signaling travels. The caller always makes the offer; the callee answers. Audio flows directly
 * between the two browsers (or through a TURN relay, once one is configured).
 *
 * - Remote ICE candidates that arrive before the remote description are queued, not dropped.
 * - Connection states are reduced to what the UI needs: connecting, connected, reconnecting, failed.
 * - offer({ iceRestart: true }) renegotiates new network paths without a new connection.
 */

export type PeerState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface PeerOptions {
  iceServers: RTCIceServer[];
  localStream: MediaStream;
  /** Send an SDP offer or answer to the other browser. */
  sendDescription: (kind: 'offer' | 'answer', sdp: string) => void;
  /** Send local ICE candidates (the signaling layer batches them). */
  sendCandidate: (candidate: IceCandidate) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onState: (state: PeerState) => void;
  /** For tests: an RTCPeerConnection stand-in. */
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

export interface Peer {
  /** Caller: create and send an offer (with an ICE restart when asked). */
  offer(options?: { iceRestart?: boolean }): Promise<void>;
  /** Callee: apply the caller's offer and send an answer. */
  acceptOffer(sdp: string): Promise<void>;
  /** Caller: apply the callee's answer. */
  acceptAnswer(sdp: string): Promise<void>;
  addRemoteCandidates(candidates: IceCandidate[]): Promise<void>;
  readonly state: PeerState;
  close(): void;
}

function toState(connection: RTCPeerConnection): PeerState {
  // connectionState where supported, iceConnectionState otherwise.
  const state: string = connection.connectionState ?? connection.iceConnectionState;
  switch (state) {
    case 'connected':
    case 'completed':
      return 'connected';
    case 'disconnected':
      return 'reconnecting';
    case 'failed':
      return 'failed';
    default:
      return 'connecting';
  }
}

export function createPeer(options: PeerOptions): Peer {
  const create = options.createConnection ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));
  const connection = create({ iceServers: options.iceServers });
  let closed = false;
  let state: PeerState = 'connecting';
  let pending: IceCandidate[] = [];

  for (const track of options.localStream.getTracks()) connection.addTrack(track, options.localStream);

  connection.onicecandidate = (event) => {
    if (closed || !event.candidate) return;
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = event.candidate;
    // An empty candidate string only means "gathering finished": nothing to send.
    if (candidate) options.sendCandidate({ candidate, sdpMid, sdpMLineIndex, usernameFragment });
  };
  connection.ontrack = (event) => {
    if (closed) return;
    options.onRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
  };
  const reportState = () => {
    if (closed) return;
    const next = toState(connection);
    if (next === state) return;
    state = next;
    options.onState(next);
  };
  connection.onconnectionstatechange = reportState;
  connection.oniceconnectionstatechange = reportState;

  async function flushPending() {
    const queued = pending;
    pending = [];
    for (const candidate of queued) {
      // A candidate the browser cannot use (e.g. for an old ICE generation) is not fatal.
      await connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  return {
    async offer({ iceRestart = false } = {}) {
      if (closed) return;
      const offer = await connection.createOffer({ iceRestart });
      await connection.setLocalDescription(offer);
      if (!closed && connection.localDescription) options.sendDescription('offer', connection.localDescription.sdp);
    },

    async acceptOffer(sdp) {
      if (closed) return;
      await connection.setRemoteDescription({ type: 'offer', sdp });
      await flushPending();
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      if (!closed && connection.localDescription) options.sendDescription('answer', connection.localDescription.sdp);
    },

    async acceptAnswer(sdp) {
      // Only an answer to our own outstanding offer is meaningful (duplicates are ignored).
      if (closed || connection.signalingState !== 'have-local-offer') return;
      await connection.setRemoteDescription({ type: 'answer', sdp });
      await flushPending();
    },

    async addRemoteCandidates(candidates) {
      if (closed) return;
      if (!connection.remoteDescription) {
        pending.push(...candidates);
        return;
      }
      for (const candidate of candidates) await connection.addIceCandidate(candidate).catch(() => undefined);
    },

    get state() {
      return state;
    },

    close() {
      if (closed) return;
      closed = true;
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.onconnectionstatechange = null;
      connection.oniceconnectionstatechange = null;
      connection.close();
    },
  };
}
