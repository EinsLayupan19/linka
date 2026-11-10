import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

/** Phones in portrait, and phones (or short windows) on their side. */
export const COMPACT_SCREEN_QUERY = '(max-width: 639px), (max-height: 499px)';

const compactQuery = () => (typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_SCREEN_QUERY) : null);

function subscribeToScreenSize(onChange: () => void): () => void {
  const media = compactQuery();
  if (!media) return () => undefined;
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/**
 * Whether the screen is compact (COMPACT_SCREEN_QUERY), following rotation and window resizes.
 * Without matchMedia (very old browsers) the floating layout is used.
 */
function useCompactScreen(): boolean {
  return useSyncExternalStore(subscribeToScreenSize, () => compactQuery()?.matches === true, () => false);
}

/**
 * Where the panel goes:
 * - fullscreen: a video call on a compact screen (the video uses the whole screen)
 * - top: anything else on a compact screen, under the safe area, so the message box stays free
 * - floating: tablets and desktops, bottom right, never taller than the visible screen
 * The element tree is the same in every layout (only classes change), so the videos and the audio
 * are never remounted by a rotation or a window resize.
 */
type CallLayout = 'fullscreen' | 'top' | 'floating';

const panelBase = 'fixed z-50 animate-call-in motion-reduce:animate-none';
const cardSurface = 'rounded-xl border border-line bg-surface p-4 shadow-lg shadow-ink/10';
const layoutClassNames: Record<CallLayout, string> = {
  fullscreen:
    'inset-0 flex flex-col overflow-hidden bg-canvas ' +
    'pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] ' +
    'pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]',
  top:
    `${cardSurface} top-[max(0.5rem,env(safe-area-inset-top))] left-[max(1rem,env(safe-area-inset-left))] ` +
    'right-[max(1rem,env(safe-area-inset-right))] mx-auto max-w-md ' +
    'max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-y-auto',
  floating: `${cardSurface} right-6 bottom-6 max-h-[calc(100dvh-3rem)] overflow-y-auto`,
};

/** Call controls: at least 44 px tall (touch), never squeezed (the row wraps instead). */
const controlClassName = 'h-auto min-h-11 whitespace-nowrap';

/**
 * The call panel: incoming call (accept / decline), calling, connecting, in call (duration, mute,
 * end), reconnecting, and a short notice when it ends. It also plays the other person's audio.
 * Never steals focus: an incoming call is announced, not forced on the user.
 */
export function CallPanel({ calls, peer }: { calls: CallsContextValue; peer: CallPeer }) {
  const { state, muted, peerMuted, remoteStream, localPreview, cameraEnabled, peerCameraEnabled, mediaError } = calls;
  const audioRef = useRef<HTMLAudioElement>(null);
  const localVideoRef = useVideoStream(localPreview);
  const remoteVideoRef = useVideoStream(remoteStream);
  const compact = useCompactScreen();

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
  // The video area exists only while video is coming or showing (not for "camera unavailable",
  // a ringing call, another tab's call, or a finished one).
  const showStage =
    videoCall &&
    (state.phase === 'preparing' || state.phase === 'outgoing' || state.phase === 'connecting' || inCall);
  const layout: CallLayout = compact ? (showStage ? 'fullscreen' : 'top') : 'floating';
  const fullscreen = layout === 'fullscreen';
  const floatingWidth = videoCall ? 'w-[min(44rem,calc(100vw-3rem))]' : 'w-80';

  return (
    <>
      {/* Remote audio. Kept mounted for the whole call, whatever the layout; nothing to see. */}
      <audio ref={audioRef} autoPlay className="hidden" />

      {state.phase !== 'idle' && (
        <section
          aria-label={videoCall ? 'Video call' : 'Call'}
          data-layout={layout}
          className={`${panelBase} ${layoutClassNames[layout]} ${layout === 'floating' ? floatingWidth : ''}`}
        >
          {/* Announced, not focused (the user may be typing): an incoming call as an alert. */}
          {state.phase === 'incoming' && <p role="alert" className="sr-only">{`${peer.name} is calling you`}</p>}
          {showStage && (
            <div
              data-testid="call-video-stage"
              className={
                fullscreen
                  ? 'relative min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface'
                  : // Never taller than the screen leaves room for: the panel's margins, the name row and the controls.
                    'relative mb-4 aspect-video max-h-[calc(100dvh-14rem)] overflow-hidden rounded-lg bg-canvas'
              }
            >
              {hasRemoteVideo && peerCameraEnabled ? (
                // Contain, never cover: a portrait phone camera is shown whole, with bars beside it.
                <video ref={remoteVideoRef} autoPlay muted playsInline aria-label={`${peer.name}'s video`} className="size-full object-contain" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
                  <Avatar name={peer.name} src={peer.avatarUrl} size="lg" />
                  <span className="text-sm">{peerCameraEnabled ? 'Waiting for video…' : 'Camera off'}</span>
                </div>
              )}
              {cameraEnabled && localPreview && (
                // Its own shape (portrait or landscape): width and height both follow the camera,
                // limited to a corner of the video area.
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  aria-label="Your camera preview"
                  className={`absolute right-3 h-auto w-auto rounded-md border border-line bg-canvas shadow-md ${
                    fullscreen ? 'top-3 max-h-[30%] max-w-[35%]' : 'bottom-3 max-h-[40%] max-w-[30%]'
                  }`}
                />
              )}
            </div>
          )}
          <div className={`flex items-center gap-3 ${fullscreen ? 'mt-3' : ''}`}>
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
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={calls.cancelCameraFallback} className={controlClassName}>Cancel</Button>
                <Button onClick={calls.continueAudioOnly} className={controlClassName}>Continue with voice</Button>
              </div>
            </div>
          )}

          <div className={`flex flex-wrap gap-2 ${fullscreen ? 'mt-3 justify-center' : 'mt-4 justify-end'}`}>
            {state.phase === 'incoming' && (
              <>
                <Button variant="danger" onClick={() => void calls.decline()} disabled={state.answering} className={controlClassName}>
                  Decline
                </Button>
                <Button onClick={() => void calls.accept()} disabled={state.answering} className={controlClassName}>
                  {state.answering ? 'Answering…' : 'Accept'}
                </Button>
                {state.cameraError && <Button variant="secondary" onClick={() => void calls.accept(true)} disabled={state.answering} className={controlClassName}>Accept without camera</Button>}
              </>
            )}
            {(state.phase === 'outgoing' || state.phase === 'preparing') && (
              <Button variant="danger" onClick={() => void calls.hangUp()} disabled={state.phase === 'preparing'} className={controlClassName}>
                Cancel
              </Button>
            )}
            {(state.phase === 'connecting' || inCall) && (
              <>
                <Button variant="secondary" onClick={calls.toggleMute} aria-pressed={muted} className={controlClassName}>
                  {muted ? 'Unmute' : 'Mute'}
                </Button>
                {videoCall && <Button variant="secondary" onClick={() => void calls.toggleCamera()} aria-pressed={cameraEnabled} className={controlClassName}>{cameraEnabled ? 'Turn camera off' : 'Turn camera on'}</Button>}
                <Button variant="danger" onClick={() => void calls.hangUp()} className={controlClassName}>End</Button>
              </>
            )}
            {state.phase === 'elsewhere' && (
              <>
                <Button variant="danger" onClick={() => void calls.hangUp()} className={controlClassName}>
                  End
                </Button>
                {state.call.status === 'active' && (
                  <Button variant="secondary" onClick={() => void calls.rejoin()} className={controlClassName}>
                    Join here
                  </Button>
                )}
              </>
            )}
            {state.phase === 'ended' && (
              <Button variant="secondary" onClick={calls.dismiss} className={controlClassName}>
                Close
              </Button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
