import type { IceCandidate } from '@linka/shared';

/**
 * One WebRTC peer connection for a 1:1 call, with no knowledge of React, Linka's API or how
 * signaling travels. The caller always makes the offer; the callee answers. Audio flows directly
 * between the two browsers (or through a TURN relay, once one is configured).
 *
 * - Remote ICE candidates that arrive before the remote description are queued, not dropped.
 * - Connection states are reduced to what the UI needs: connecting, connected, reconnecting, failed.
 * - offer({ iceRestart: true }) renegotiates new network paths without a new connection.
 *
 * Video calls always negotiate one two-way (sendrecv) video line, with or without a camera, so the
 * camera can be turned on, off and on again later with replaceTrack and no new offer. (Only the
 * caller ever offers, so the callee could not start a renegotiation of its own.)
 * - Caller: the line comes from its camera track, or an empty transceiver added before the offer.
 * - Callee: the line comes from the caller's offer. A transceiver the callee added itself before the
 *   offer arrived would never be part of the call: browsers only reuse addTrack transceivers for a
 *   remote offer, so the callee instead makes the offer's video line two-way before answering.
 */

export type PeerState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface PeerOptions {
  iceServers: RTCIceServer[];
  localStream: MediaStream;
  /** Keep a video transceiver negotiated even when this tab joins without a camera track. */
  video?: boolean;
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
  /** Replace the negotiated video sender track without rebuilding the peer connection. */
  replaceVideoTrack(track: MediaStreamTrack | null): Promise<void>;
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

  // A video call has exactly one video transceiver (see above); a voice call has none.
  const videoTransceiver = () => connection.getTransceivers().find((t) => t.receiver.track.kind === 'video');

  connection.onicecandidate = (event) => {
    if (closed || !event.candidate) return;
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = event.candidate;
    // An empty candidate string only means "gathering finished": nothing to send.
    if (candidate) options.sendCandidate({ candidate, sdpMid, sdpMLineIndex, usernameFragment });
  };
  // All remote tracks in one stream. Video sent on a line negotiated before the other person's
  // camera was on arrives without a stream; on its own stream it would replace (and silence) the
  // audio. A new stream object for each added track lets React notice the change.
  let remote: MediaStream | null = null;
  connection.ontrack = (event) => {
    if (closed) return;
    const tracks = remote?.getTracks() ?? [];
    if (tracks.includes(event.track)) return;
    remote = new MediaStream([...tracks, event.track]);
    options.onRemoteStream(remote);
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
      if (options.video && !videoTransceiver()) connection.addTransceiver('video', { direction: 'sendrecv', streams: [options.localStream] });
      const offer = await connection.createOffer({ iceRestart });
      await connection.setLocalDescription(offer);
      if (!closed && connection.localDescription) options.sendDescription('offer', connection.localDescription.sdp);
    },

    async acceptOffer(sdp) {
      if (closed) return;
      await connection.setRemoteDescription({ type: 'offer', sdp });
      await flushPending();
      // Without a camera, the offer's video line would be answered receive-only.
      const video = options.video ? videoTransceiver() : undefined;
      if (video && video.direction === 'recvonly') video.direction = 'sendrecv';
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

    async replaceVideoTrack(track) {
      if (closed) return;
      // Voice calls have no video line; adding one would need a renegotiation they never do.
      await videoTransceiver()?.sender.replaceTrack(track);
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
