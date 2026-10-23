import { useEffect, useRef, useState } from 'react';
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

/** One line describing the call, for sighted users and the live region alike. */
function statusText(state: CallState, peer: CallPeer, duration: string | null, peerMuted: boolean): string {
  switch (state.phase) {
    case 'idle':
      return '';
    case 'preparing':
      return 'Starting the call…';
    case 'outgoing':
      return 'Calling…';
    case 'incoming':
      return 'Incoming voice call';
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
  const { state, muted, peerMuted, remoteStream } = calls;
  const audioRef = useRef<HTMLAudioElement>(null);

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

  return (
    <>
      {/* Remote audio. Kept mounted for the whole call; nothing to see. */}
      <audio ref={audioRef} autoPlay className="hidden" />

      {state.phase !== 'idle' && (
        <section
          aria-label="Call"
          className="fixed inset-x-4 bottom-4 z-50 rounded-xl border border-line bg-surface p-4 shadow-lg shadow-ink/10 animate-call-in motion-reduce:animate-none sm:left-auto sm:right-6 sm:bottom-6 sm:w-80"
        >
          {/* Announced, not focused (the user may be typing): an incoming call as an alert. */}
          {state.phase === 'incoming' && <p role="alert" className="sr-only">{`${peer.name} is calling you`}</p>}
          <div className="flex items-center gap-3">
            <Avatar name={peer.name} src={peer.avatarUrl} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{state.phase === 'preparing' || state.phase === 'ended' && !call ? 'Voice call' : peer.name}</p>
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

          <div className="mt-4 flex justify-end gap-2">
            {state.phase === 'incoming' && (
              <>
                <Button variant="danger" onClick={() => void calls.decline()} disabled={state.answering}>
                  Decline
                </Button>
                <Button onClick={() => void calls.accept()} disabled={state.answering}>
                  {state.answering ? 'Answering…' : 'Accept'}
                </Button>
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
                <Button variant="danger" onClick={() => void calls.hangUp()}>
                  End
                </Button>
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
