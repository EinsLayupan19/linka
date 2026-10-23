import { describe, expect, it, vi } from 'vitest';
import { FakeMediaStream, FakePeerConnection } from '../test/webrtc';
import { createPeer, type PeerOptions } from './webrtc';

function setup(overrides: Partial<PeerOptions> = {}) {
  let connection: FakePeerConnection | undefined;
  const options = {
    iceServers: [{ urls: 'stun:stun.test' }],
    localStream: new FakeMediaStream() as unknown as MediaStream,
    sendDescription: vi.fn(),
    sendCandidate: vi.fn(),
    onRemoteStream: vi.fn(),
    onState: vi.fn(),
    createConnection: (config: RTCConfiguration) => {
      connection = new FakePeerConnection(config);
      return connection as unknown as RTCPeerConnection;
    },
    ...overrides,
  };
  const peer = createPeer(options);
  return { peer, options, connection: connection! };
}

describe('createPeer', () => {
  it('uses the given ICE servers and sends the microphone track', () => {
    const { connection } = setup();
    expect(connection.config).toEqual({ iceServers: [{ urls: 'stun:stun.test' }] });
    expect(connection.tracks).toHaveLength(1);
  });

  it('caller: creates and sends an offer, then applies the answer', async () => {
    const { peer, options, connection } = setup();
    await peer.offer();
    expect(options.sendDescription).toHaveBeenCalledWith('offer', expect.stringMatching(/^offer-sdp/));

    await peer.acceptAnswer('answer-sdp');
    expect(connection.remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' });
    // A duplicate answer (no outstanding offer) is ignored instead of throwing.
    await expect(peer.acceptAnswer('answer-sdp')).resolves.toBeUndefined();
  });

  it('callee: applies the offer and sends an answer', async () => {
    const { peer, options, connection } = setup();
    await peer.acceptOffer('offer-sdp');
    expect(connection.remoteDescription).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    expect(options.sendDescription).toHaveBeenCalledWith('answer', expect.stringMatching(/^answer-sdp/));
  });

  it('queues remote candidates that arrive before the remote description', async () => {
    const { peer, connection } = setup();
    await peer.addRemoteCandidates([{ candidate: 'early' }]);
    expect(connection.addedCandidates).toEqual([]);

    await peer.acceptOffer('offer-sdp');
    await peer.addRemoteCandidates([{ candidate: 'late' }]);
    expect(connection.addedCandidates).toEqual([{ candidate: 'early' }, { candidate: 'late' }]);
  });

  it('passes local candidates on, skipping the end-of-gathering marker', () => {
    const { options, connection } = setup();
    connection.gather('candidate:1');
    connection.onicecandidate?.({ candidate: { candidate: '' } });
    connection.onicecandidate?.({ candidate: null });
    expect(options.sendCandidate).toHaveBeenCalledTimes(1);
    expect(options.sendCandidate).toHaveBeenCalledWith({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' });
  });

  it('reports remote audio and simplified connection states, once per change', () => {
    const { peer, options, connection } = setup();
    const stream = connection.receiveTrack();
    expect(options.onRemoteStream).toHaveBeenCalledWith(stream);

    connection.setState('connected');
    connection.setState('connected');
    connection.setState('disconnected');
    connection.setState('failed');
    expect(vi.mocked(options.onState).mock.calls.map(([s]) => s)).toEqual(['connected', 'reconnecting', 'failed']);
    expect(peer.state).toBe('failed');
  });

  it('asks for an ICE restart when renegotiating', async () => {
    const { peer, connection } = setup();
    await peer.offer({ iceRestart: true });
    expect(connection.offers).toEqual([{ iceRestart: true }]);
  });

  it('goes quiet once closed', async () => {
    const { peer, options, connection } = setup();
    peer.close();
    expect(connection.closed).toBe(true);
    connection.gather('candidate:late');
    connection.setState('connected');
    await peer.offer();
    expect(options.sendCandidate).not.toHaveBeenCalled();
    expect(options.onState).not.toHaveBeenCalled();
    expect(options.sendDescription).not.toHaveBeenCalled();
  });
});
