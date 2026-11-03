import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallEndReason, CallsContextValue, CallState } from '../../hooks/useCalls';
import { formatCallDuration } from '../../utils/time';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';

export interface CallPeer {
  name: string;
  avatarUrl: string | null;
}

/** The current time, ticking every second while `active`. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

function endedText(reason: CallEndReason, name: string, duration: string | null, message: string | null): string {
  switch (reason) {
    case 'ended':
      return duration ? `Call ended · ${duration}` : 'Call ended';
    case 'declined':
      return `${name} declined the call`;
    case 'no-answer':
      return `${name} didn’t answer`;
    case 'missed':
      return `Missed call from ${name}`;
    case 'cancelled':
      return 'Call cancelled';
    case 'lost':
      return 'Call ended: the connection was lost';
    case 'replaced':
      return 'The call continued in another tab';
    case 'failed':
      return message ?? 'The call could not be started.';
  }
}

/**
 * A ref callback that shows `stream` in a <video>. The videos are unmounted while a camera is off,
 * so the stream is attached whenever an element is (re)created, not only when the stream changes.
 */
function useVideoStream(stream: MediaStream | null) {
  return useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      video.srcObject = stream;
      if (stream) void video.play?.()?.catch(() => undefined);
    },
    [stream],
  );
}

/** One line describing the call, for sighted users and the live region alike. */
function statusText(state: CallState, peer: CallPeer, duration: string | null, peerMuted: boolean): string {
  switch (state.phase) {
    case 'idle':
      return '';
    case 'preparing':
      return state.type === 'video' ? 'Starting video call…' : 'Starting the call…';
    case 'camera-fallback':
      return 'Camera unavailable';
    case 'outgoing':
      return 'Calling…';
    case 'incoming':
      return state.call.type === 'video' ? 'Incoming video call' : 'Incoming voice call';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return peerMuted ? `${peer.name} is muted` : 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'elsewhere':
      return state.call.status === 'ringing' ? 'Calling from another tab' : 'On this call in another tab';
    case 'ended':
      return endedText(state.reason, peer.name, duration, state.message);
  }
}

/**
 * The floating call panel: incoming call (accept / decline), calling, connecting, in call
 * (duration, mute, end), reconnecting, and a short notice when it ends. It also plays the other
 * person's audio. Never steals focus: an incoming call is announced, not forced on the user.
 */
export function CallPanel({ calls, peer }: { calls: CallsContextValue; peer: CallPeer }) {
  const { state, muted, peerMuted, remoteStream, localPreview, cameraEnabled, peerCameraEnabled, mediaError } = calls;
  const audioRef = useRef<HTMLAudioElement>(null);
  const localVideoRef = useVideoStream(localPreview);
  const remoteVideoRef = useVideoStream(remoteStream);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = remoteStream;
    if (remoteStream) void audio.play?.()?.catch(() => undefined);
  }, [remoteStream]);

  const call = 'call' in state ? state.call : null;
  const startedAt = call?.startedAt ? new Date(call.startedAt).getTime() : null;
  const inCall = state.phase === 'connected' || state.phase === 'reconnecting';
  const now = useNow(inCall && startedAt !== null);
  const endedAt = call?.endedAt ? new Date(call.endedAt).getTime() : null;
  const duration =
    startedAt === null ? null : formatCallDuration((state.phase === 'ended' ? (endedAt ?? now) : now) - startedAt);
  const status = statusText(state, peer, duration, peerMuted);
  const videoCall = (('call' in state && state.call?.type === 'video') || (state.phase === 'preparing' && state.type === 'video') || state.phase === 'camera-fallback');
  const hasRemoteVideo = Boolean(remoteStream?.getVideoTracks().some((track) => track.readyState !== 'ended' && track.enabled));

  return (
    <>
      {/* Remote audio. Kept mounted for the whole call; nothing to see. */}
      <audio ref={audioRef} autoPlay className="hidden" />

      {state.phase !== 'idle' && (
        <section
          aria-label={videoCall ? 'Video call' : 'Call'}
          className={`fixed inset-x-4 bottom-4 z-50 rounded-xl border border-line bg-surface p-4 shadow-lg shadow-ink/10 animate-call-in motion-reduce:animate-none sm:left-auto sm:right-6 sm:bottom-6 ${videoCall ? 'sm:w-[min(44rem,calc(100vw-3rem))]' : 'sm:w-80'}`}
        >
          {/* Announced, not focused (the user may be typing): an incoming call as an alert. */}
          {state.phase === 'incoming' && <p role="alert" className="sr-only">{`${peer.name} is calling you`}</p>}
          {videoCall && state.phase !== 'incoming' && state.phase !== 'elsewhere' && state.phase !== 'ended' && (
            <div className="relative mb-4 aspect-video overflow-hidden rounded-lg bg-canvas">
              {hasRemoteVideo && peerCameraEnabled ? (
                <video ref={remoteVideoRef} autoPlay muted playsInline aria-label={`${peer.name}'s video`} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
                  <Avatar name={peer.name} src={peer.avatarUrl} size="lg" />
                  <span className="text-sm">{peerCameraEnabled ? 'Waiting for video…' : 'Camera off'}</span>
                </div>
              )}
              {cameraEnabled && localPreview && (
                <video ref={localVideoRef} autoPlay muted playsInline aria-label="Your camera preview" className="absolute bottom-3 right-3 aspect-video w-1/4 min-w-20 rounded-md border border-line object-cover shadow-md" />
              )}
            </div>
          )}
          <div className="flex items-center gap-3">
            <Avatar name={peer.name} src={peer.avatarUrl} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{state.phase === 'preparing' || state.phase === 'camera-fallback' || state.phase === 'ended' && !call ? (videoCall ? 'Video call' : 'Voice call') : peer.name}</p>
              <p
                role={state.phase === 'incoming' ? undefined : 'status'}
                className={`truncate text-sm ${state.phase === 'reconnecting' ? 'text-warning' : state.phase === 'ended' && state.reason !== 'ended' ? 'text-ink' : 'text-ink-muted'}`}>
                {status}
              </p>
            </div>
            {inCall && duration && (
              <time aria-label={`Call duration ${duration}`} className="shrink-0 text-sm font-medium tabular-nums">
                {duration}
              </time>
            )}
          </div>

          {state.phase === 'incoming' && state.error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {state.error}
            </p>
          )}
          {state.phase === 'incoming' && state.cameraError && (
            <p role="alert" className="mt-3 text-sm text-warning">{state.cameraError} You can accept with audio only.</p>
          )}
          {mediaError && state.phase !== 'incoming' && <p role="status" className="mt-3 text-sm text-warning">{mediaError}</p>}
          {state.phase === 'camera-fallback' && (
            <div className="mt-3 rounded-lg border border-line p-3">
              <p role="alert" className="text-sm text-ink-muted">{state.message}</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="secondary" onClick={calls.cancelCameraFallback}>Cancel</Button>
                <Button onClick={calls.continueAudioOnly}>Continue with voice</Button>
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            {state.phase === 'incoming' && (
              <>
                <Button variant="danger" onClick={() => void calls.decline()} disabled={state.answering}>
                  Decline
                </Button>
                <Button onClick={() => void calls.accept()} disabled={state.answering}>
                  {state.answering ? 'Answering…' : 'Accept'}
                </Button>
                {state.cameraError && <Button variant="secondary" onClick={() => void calls.accept(true)} disabled={state.answering}>Accept without camera</Button>}
              </>
            )}
            {(state.phase === 'outgoing' || state.phase === 'preparing') && (
              <Button variant="danger" onClick={() => void calls.hangUp()} disabled={state.phase === 'preparing'}>
                Cancel
              </Button>
            )}
            {(state.phase === 'connecting' || inCall) && (
              <>
                <Button variant="secondary" onClick={calls.toggleMute} aria-pressed={muted}>
                  {muted ? 'Unmute' : 'Mute'}
                </Button>
                {videoCall && <Button variant="secondary" onClick={() => void calls.toggleCamera()} aria-pressed={cameraEnabled}>{cameraEnabled ? 'Turn camera off' : 'Turn camera on'}</Button>}
                <Button variant="danger" onClick={() => void calls.hangUp()}>End</Button>
              </>
            )}
            {state.phase === 'elsewhere' && (
              <>
                <Button variant="danger" onClick={() => void calls.hangUp()}>
                  End
                </Button>
                {state.call.status === 'active' && (
                  <Button variant="secondary" onClick={() => void calls.rejoin()}>
                    Join here
                  </Button>
                )}
              </>
            )}
            {state.phase === 'ended' && (
              <Button variant="secondary" onClick={calls.dismiss}>
                Close
              </Button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
