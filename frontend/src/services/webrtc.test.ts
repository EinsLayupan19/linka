import { describe, expect, it, vi } from 'vitest';
import { FakeMediaStream, FakePeerConnection, FakeTrack } from '../test/webrtc';
import { createPeer, type PeerOptions } from './webrtc';

function setup(overrides: Partial<PeerOptions> = {}) {
  vi.stubGlobal('MediaStream', FakeMediaStream); // jsdom has none (setup.ts unstubs it afterwards)
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

  describe('video', () => {
    const negotiatedVideo = (connection: FakePeerConnection) =>
      connection.transceivers.filter((t) => t.mid !== null && t.receiver.track.kind === 'video');

    it('caller without a camera still offers a video line, and fills it later without rebuilding', async () => {
      const { peer, options, connection } = setup({ video: true });
      await peer.offer();
      expect(options.sendDescription).toHaveBeenCalledWith('offer', expect.stringContaining('m=video:sendrecv'));

      const camera = new FakeTrack('video');
      await peer.replaceVideoTrack(camera as unknown as MediaStreamTrack);
      expect(negotiatedVideo(connection).map((t) => t.sender.track)).toEqual([camera]);

      await peer.replaceVideoTrack(null);
      expect(negotiatedVideo(connection).map((t) => t.sender.track)).toEqual([null]);
      expect(connection.closed).toBe(false);
    });

    it('callee who answered without a camera sends one later on the line the offer negotiated', async () => {
      const { peer, options, connection } = setup({ video: true });
      await peer.acceptOffer('offer-sdp m=audio:sendrecv m=video:sendrecv');
      // The answer agrees to send video, so turning the camera on needs no new offer.
      expect(options.sendDescription).toHaveBeenCalledWith('answer', expect.stringContaining('m=video:sendrecv'));

      const camera = new FakeTrack('video');
      await peer.replaceVideoTrack(camera as unknown as MediaStreamTrack);

      expect(negotiatedVideo(connection).map((t) => t.sender.track)).toEqual([camera]);
      // No stray transceiver that the other browser would never hear about.
      expect(connection.transceivers.filter((t) => t.mid === null)).toEqual([]);
    });

    it('callee who answered with a camera sends it on the negotiated line and can turn it off and on', async () => {
      const camera = new FakeTrack('video');
      const localStream = new FakeMediaStream([new FakeTrack('audio'), camera]) as unknown as MediaStream;
      const { peer, connection } = setup({ video: true, localStream });
      await peer.acceptOffer('offer-sdp m=audio:sendrecv m=video:sendrecv');
      expect(negotiatedVideo(connection).map((t) => t.sender.track)).toEqual([camera]);

      await peer.replaceVideoTrack(null);
      const again = new FakeTrack('video');
      await peer.replaceVideoTrack(again as unknown as MediaStreamTrack);
      expect(negotiatedVideo(connection).map((t) => t.sender.track)).toEqual([again]);
    });

    it('voice calls negotiate no video', async () => {
      const { peer, options } = setup();
      await peer.offer();
      expect(options.sendDescription).toHaveBeenCalledWith('offer', expect.not.stringContaining('m=video'));
    });

    it('combines remote audio and video into one stream, even when the video arrives without a stream', () => {
      const { options, connection } = setup({ video: true });
      const audio = connection.receiveTrack('audio');
      const video = connection.receiveTrack('video', { withStream: false });

      const reported = vi.mocked(options.onRemoteStream).mock.calls.map(([stream]) => stream as unknown as FakeMediaStream);
      // Audio must keep playing when the video joins: the latest stream carries both.
      expect(reported.at(-1)!.getTracks()).toEqual([audio, video]);
      // A new stream object each time, so the UI notices the added track.
      expect(reported[0]).not.toBe(reported[1]);
    });
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
    const track = connection.receiveTrack();
    const [[stream]] = vi.mocked(options.onRemoteStream).mock.calls as unknown as [[FakeMediaStream]];
    expect(stream.getTracks()).toEqual([track]);

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
