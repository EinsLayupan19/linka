import { vi } from 'vitest';

/**
 * Stand-ins for the browser's WebRTC and media APIs (jsdom has neither). They follow the real
 * offer/answer state machine closely enough to test Linka's signaling, but carry no media: what a
 * real network, NAT or device does cannot be unit-tested (see DEVELOPMENT_STATUS.md).
 */

export class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(readonly kind: 'audio' | 'video' = 'audio') {}
  stop() {
    this.stopped = true;
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
}

let nextId = 0;

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly id = ++nextId;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  tracks: unknown[] = [];
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

  addTrack(track: unknown) {
    this.tracks.push(track);
  }
  async createOffer(options: { iceRestart?: boolean } = {}) {
    this.offers.push(options);
    return { type: 'offer', sdp: `offer-sdp-${this.id}-${this.offers.length}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `answer-sdp-${this.id}` };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    if (description.type === 'answer' && this.signalingState !== 'have-local-offer') throw new Error('InvalidStateError');
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
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
  /** Remote audio arrived. */
  receiveTrack() {
    const stream = new FakeMediaStream();
    this.ontrack?.({ streams: [stream], track: stream.getTracks()[0] });
    return stream;
  }
}

/** Installs the fakes for the current test (setup.ts unstubs globals afterwards). */
export function installWebRtcFakes({ microphone = 'granted' }: { microphone?: 'granted' | 'denied' | 'missing' } = {}) {
  FakePeerConnection.instances = [];
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  const streams: FakeMediaStream[] = [];
  const getUserMedia = vi.fn(async () => {
    if (microphone === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
    if (microphone === 'missing') throw new DOMException('Requested device not found', 'NotFoundError');
    const stream = new FakeMediaStream();
    streams.push(stream);
    return stream;
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  // jsdom's media elements cannot play.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
  return { getUserMedia, streams, peers: () => FakePeerConnection.instances, latestPeer: () => FakePeerConnection.instances.at(-1) };
}
