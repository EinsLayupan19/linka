import { vi } from 'vitest';

/**
 * Stand-ins for the browser's WebRTC and media APIs (jsdom has neither). They follow the real
 * offer/answer state machine closely enough to test Linka's signaling, but carry no media: what a
 * real network, NAT or device does cannot be unit-tested (see DEVELOPMENT_STATUS.md).
 */

export class FakeTrack {
  enabled = true;
  stopped = false;
  readyState: MediaStreamTrackState = 'live';
  onended: (() => void) | null = null;
  constructor(readonly kind: 'audio' | 'video' = 'audio') {}
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

export class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  addTrack(track: FakeTrack) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track: FakeTrack) { const index = this.tracks.indexOf(track); if (index >= 0) this.tracks.splice(index, 1); }
}

let nextId = 0;

/**
 * One m= line's worth of sending and receiving. `origin` matters like in real browsers: a remote
 * offer reuses only transceivers made by addTrack that are not yet associated (JSEP 5.10); ones
 * made by addTransceiver stay unassociated, and the offer gets a new, receive-only transceiver.
 */
export interface FakeTransceiver {
  mid: string | null;
  direction: RTCRtpTransceiverDirection;
  origin: 'addTrack' | 'addTransceiver' | 'remote';
  receiver: { track: { kind: string } };
  sender: { track: unknown; replaceTrack(track: unknown): Promise<void> };
}

function fakeTransceiver(kind: string, origin: FakeTransceiver['origin'], direction: RTCRtpTransceiverDirection, track: unknown = null): FakeTransceiver {
  return {
    mid: null,
    direction,
    origin,
    receiver: { track: { kind } },
    sender: {
      track,
      async replaceTrack(next: unknown) {
        this.track = next;
      },
    },
  };
}

/** Fake SDP: an id followed by one `m=<kind>:<direction>` per media line, e.g. "offer-sdp-1-1 m=audio:sendrecv". */
function mediaLines(transceivers: FakeTransceiver[]) {
  return transceivers.map((t) => ` m=${t.receiver.track.kind}:${t.direction}`).join('');
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly id = ++nextId;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  tracks: unknown[] = [];
  transceivers: FakeTransceiver[] = [];
  addedCandidates: unknown[] = [];
  offers: { iceRestart?: boolean }[] = [];
  closed = false;

  onicecandidate: ((event: { candidate: Partial<RTCIceCandidate> | null }) => void) | null = null;
  ontrack: ((event: { streams: unknown[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(readonly config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    this.tracks.push(track);
    this.transceivers.push(fakeTransceiver(track.kind, 'addTrack', 'sendrecv', track));
  }
  addTransceiver(kind: string, init: { direction?: RTCRtpTransceiverDirection } = {}) {
    const transceiver = fakeTransceiver(kind, 'addTransceiver', init.direction ?? 'sendrecv');
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  async createOffer(options: { iceRestart?: boolean } = {}) {
    this.offers.push(options);
    return { type: 'offer', sdp: `offer-sdp-${this.id}-${this.offers.length}${mediaLines(this.transceivers)}` };
  }
  async createAnswer() {
    // An answer only covers the offer's lines: unassociated transceivers are left out.
    return { type: 'answer', sdp: `answer-sdp-${this.id}${mediaLines(this.transceivers.filter((t) => t.mid !== null))}` };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    if (description.type === 'offer') this.transceivers.forEach((t, index) => (t.mid ??= String(index)));
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    if (description.type === 'answer' && this.signalingState !== 'have-local-offer') throw new Error('InvalidStateError');
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (description.type === 'offer') this.associate(description.sdp);
  }
  /** Matches the offer's media lines to transceivers the way a browser does. */
  private associate(sdp: string) {
    [...sdp.matchAll(/ m=(audio|video):/g)].forEach(([, kind], index) => {
      const mid = String(index);
      if (this.transceivers.some((t) => t.mid === mid)) return; // renegotiation of a known line
      const reusable = this.transceivers.find((t) => t.mid === null && t.origin === 'addTrack' && t.receiver.track.kind === kind);
      const transceiver = reusable ?? fakeTransceiver(kind!, 'remote', 'recvonly');
      if (!reusable) this.transceivers.push(transceiver);
      transceiver.mid = mid;
    });
  }
  async addIceCandidate(candidate: unknown) {
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description');
    this.addedCandidates.push(candidate);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  // --- test controls ---
  /** The browser found a local candidate. */
  gather(candidate: string) {
    this.onicecandidate?.({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' } });
  }
  /** The connection changed state (connected, disconnected, failed...). */
  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  /**
   * A remote track arrived. Browsers give no stream when the sender's track has none (e.g. video
   * the other person sends on a line that was negotiated before their camera was on).
   */
  receiveTrack(kind: 'audio' | 'video' = 'audio', { withStream = true }: { withStream?: boolean } = {}) {
    const track = new FakeTrack(kind);
    const stream = new FakeMediaStream([track]);
    this.ontrack?.({ streams: withStream ? [stream] : [], track });
    return track;
  }
}

/** Installs the fakes for the current test (setup.ts unstubs globals afterwards). */
export function installWebRtcFakes({ microphone = 'granted', camera = 'granted' }: { microphone?: 'granted' | 'denied' | 'missing'; camera?: 'granted' | 'denied' | 'missing' } = {}) {
  FakePeerConnection.instances = [];
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  const streams: FakeMediaStream[] = [];
  const getUserMedia = vi.fn(async (constraints?: MediaStreamConstraints) => {
    const wantsVideo = Boolean(constraints?.video);
    const access = wantsVideo ? camera : microphone;
    if (access === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
    if (access === 'missing') throw new DOMException('Requested device not found', 'NotFoundError');
    const stream = new FakeMediaStream([new FakeTrack(wantsVideo ? 'video' : 'audio')]);
    streams.push(stream);
    return stream;
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  // jsdom's media elements cannot play.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
  return { getUserMedia, streams, peers: () => FakePeerConnection.instances, latestPeer: () => FakePeerConnection.instances.at(-1) };
}
