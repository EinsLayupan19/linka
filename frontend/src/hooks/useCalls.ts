import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CALL_HEARTBEAT_SECONDS, CALL_RING_TIMEOUT_SECONDS, type Call } from '@linka/shared';
import { ApiError, toApiError } from '../lib/api';
import { startCallSession, type CallConnectionState, type CallSession } from '../services/callSession';
import {
  acceptCall,
  declineCall,
  endCall,
  getCall,
  getIceServers,
  listOngoingCalls,
  sendCallHeartbeat,
  startCall as startCallRequest,
} from '../services/calls';
import { getMicrophone, stopStream } from '../services/microphone';

/** Why a call is over, as shown to this user. */
export type CallEndReason =
  | 'ended' // hung up after talking
  | 'declined' // the other person refused
  | 'no-answer' // nobody answered our call
  | 'missed' // we did not answer theirs
  | 'cancelled' // we stopped calling
  | 'lost' // the connection could not be restored
  | 'replaced' // continued in another tab
  | 'failed'; // could not start (microphone, busy, network): see message

export type CallState =
  | { phase: 'idle' }
  /** Getting the microphone and ringing the other person. */
  | { phase: 'preparing'; conversationId: string }
  /** Our call rings on their side. */
  | { phase: 'outgoing'; call: Call }
  /** Their call rings here. */
  | { phase: 'incoming'; call: Call; answering: boolean; error: string | null }
  | { phase: 'connecting' | 'connected' | 'reconnecting'; call: Call }
  /** Ongoing, but not in this tab (answered in another tab, or this page was reloaded). */
  | { phase: 'elsewhere'; call: Call }
  | { phase: 'ended'; call: Call | null; reason: CallEndReason; message: string | null };

export interface CallsContextValue {
  state: CallState;
  /** A call is starting, ringing or connected: no second one can start. */
  busy: boolean;
  muted: boolean;
  peerMuted: boolean;
  /** The other person's audio (played by CallPanel). */
  remoteStream: MediaStream | null;
  startCall: (conversationId: string) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangUp: () => Promise<void>;
  /** Moves an ongoing call into this tab (after a reload, or from another tab). */
  rejoin: () => Promise<void>;
  toggleMute: () => void;
  dismiss: () => void;
  /** call.updated from the user channel. */
  handleCallUpdate: (call: Call) => void;
  /** Fetch the ongoing calls again (after (re)joining the user channel). */
  resync: () => void;
}

/** How long the "call ended" notice stays. */
export const ENDED_NOTICE_MS = 4000;

const isOngoingPhase = (state: CallState): state is Extract<CallState, { call: Call }> & { phase: Exclude<CallState['phase'], 'ended'> } =>
  state.phase !== 'idle' && state.phase !== 'ended' && state.phase !== 'preparing';

/**
 * All call state for the signed-in user: one call at a time, for the whole app.
 *
 * The API decides what a call is (ringing, active, over); every update from it, whether a
 * response, a call.updated event or a resync, goes through apply(). This tab's own media and
 * connection (microphone, WebRTC, signaling) exist only while this tab "owns" the call: it started
 * it, answered it or rejoined it. Everything is released when the call ends or this unmounts.
 */
export function useCallManager(myUserId: string): CallsContextValue {
  const [state, setStateValue] = useState<CallState>({ phase: 'idle' });
  const [muted, setMuted] = useState(false);
  const [peerMuted, setPeerMuted] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const stateRef = useRef(state);
  const setState = useCallback((next: CallState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const owned = useRef<string | null>(null);
  /** A call we are starting but whose id we do not know yet (its call.updated may arrive first). */
  const startingIn = useRef<string | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const session = useRef<CallSession | null>(null);
  /** The connection's latest state, even while the panel cannot show it yet (still "Calling…"). */
  const connection = useRef<CallConnectionState>('connecting');
  const timers = useRef({ heartbeat: undefined as Interval, ring: undefined as Timer, notice: undefined as Timer });

  /** Releases this tab's media and connection (the call itself is not touched). */
  const release = useCallback(() => {
    session.current?.close();
    session.current = null;
    stopStream(localStream.current);
    localStream.current = null;
    clearInterval(timers.current.heartbeat);
    clearTimeout(timers.current.ring);
    timers.current.heartbeat = undefined;
    timers.current.ring = undefined;
    owned.current = null;
    connection.current = 'connecting';
    setRemoteStream(null);
    setMuted(false);
    setPeerMuted(false);
  }, []);

  const finish = useCallback(
    (call: Call | null, reason: CallEndReason, message: string | null = null) => {
      release();
      const notice: CallState = { phase: 'ended', call, reason, message };
      setState(notice);
      clearTimeout(timers.current.notice);
      timers.current.notice = setTimeout(() => {
        if (stateRef.current === notice) setState({ phase: 'idle' });
      }, ENDED_NOTICE_MS);
    },
    [release, setState],
  );

  const reasonFor = useCallback(
    (call: Call): CallEndReason => {
      const iCalled = call.initiatorId === myUserId;
      if (call.status === 'declined') return iCalled ? 'declined' : 'missed';
      if (call.status === 'missed') return iCalled ? 'no-answer' : 'missed';
      return 'ended';
    },
    [myUserId],
  );

  /** Server truth about a call: decides what this tab shows. */
  const apply = useCallback(
    (call: Call) => {
      const current = stateRef.current;
      const me = call.participants.find((p) => p.userId === myUserId);
      if (!me) return;
      const shown = isOngoingPhase(current) ? current.call : null;
      // One call at a time: anything else is ignored (the API prevents it in normal use).
      if (shown && shown.id !== call.id) return;
      if (!shown && current.phase === 'ended' && current.call?.id === call.id) return; // late event
      const iCalled = call.initiatorId === myUserId;
      const mine = owned.current === call.id || (iCalled && startingIn.current === call.conversationId);
      if (current.phase === 'preparing' && mine) return; // our start request will answer

      if (call.status === 'ringing') {
        if (mine) setState({ phase: 'outgoing', call });
        else if (iCalled || me.leftAt) setState({ phase: 'elsewhere', call });
        else if (current.phase === 'incoming') setState({ ...current, call });
        else if (!shown) setState({ phase: 'incoming', call, answering: false, error: null });
        return;
      }
      if (call.status === 'active') {
        if (mine) {
          // WebRTC may already be connected when the "answered" event arrives.
          if (current.phase === 'outgoing') setState({ phase: connection.current === 'connected' ? 'connected' : 'connecting', call });
          else if (isOngoingPhase(current) && current.phase !== 'elsewhere' && current.phase !== 'incoming') setState({ ...current, call });
        } else if (me.joinedAt && !me.leftAt) {
          setState({ phase: 'elsewhere', call });
        } else if (shown) {
          finish(call, 'missed'); // not for us any more
        }
        return;
      }
      // declined, missed, ended
      if (shown || mine) finish(call, reasonFor(call));
    },
    [finish, myUserId, reasonFor, setState],
  );

  const refresh = useCallback(
    (callId: string) => {
      getCall(callId).then(apply, () => undefined);
    },
    [apply],
  );

  const startHeartbeat = useCallback(
    (callId: string) => {
      clearInterval(timers.current.heartbeat);
      const beat = () =>
        sendCallHeartbeat(callId).catch((error: unknown) => {
          // Over on the server (ended elsewhere, or expired): find out how.
          if (error instanceof ApiError && (error.status === 409 || error.status === 404)) refresh(callId);
        });
      timers.current.heartbeat = setInterval(beat, CALL_HEARTBEAT_SECONDS * 1000);
      void beat();
    },
    [refresh],
  );

  /** Ends the call on the server (retrying once) and shows why. Media stops immediately. */
  const endAndFinish = useCallback(
    async (call: Call, reason: CallEndReason) => {
      release();
      let ended: Call | null = null;
      for (let attempt = 0; attempt < 2 && !ended; attempt++) ended = await endCall(call.id).catch(() => null);
      finish(ended ?? call, reason);
    },
    [finish, release],
  );

  /** Joins the call's signaling channel and starts WebRTC in this tab. */
  const connect = useCallback(
    async (call: Call, role: 'caller' | 'callee') => {
      const iceServers = await getIceServers();
      const stream = localStream.current;
      const peer = call.participants.find((p) => p.userId !== myUserId);
      if (owned.current !== call.id || !stream || !peer) return; // ended while we were waiting
      const onState = (next: CallConnectionState) => {
        if (owned.current !== call.id) return;
        connection.current = next;
        const current = stateRef.current;
        if (next === 'lost') {
          void endAndFinish(isOngoingPhase(current) ? current.call : call, 'lost');
          return;
        }
        // While our call still rings there is nothing to connect to yet.
        if (current.phase === 'outgoing' || !isOngoingPhase(current) || current.phase === 'elsewhere') return;
        setState({ phase: next, call: current.call });
      };
      session.current?.close();
      session.current = startCallSession({
        callId: call.id,
        myUserId,
        peerUserId: peer.userId,
        role,
        iceServers,
        localStream: stream,
        onRemoteStream: setRemoteStream,
        onState,
        onPeerMuted: setPeerMuted,
        onReplaced: () => {
          const current = stateRef.current;
          release();
          setState({ phase: 'elsewhere', call: isOngoingPhase(current) ? current.call : call });
        },
      });
    },
    [endAndFinish, myUserId, release, setState],
  );

  const startCall = useCallback(
    async (conversationId: string) => {
      const current = stateRef.current;
      if (current.phase !== 'idle' && current.phase !== 'ended') return;
      clearTimeout(timers.current.notice);
      setState({ phase: 'preparing', conversationId });
      startingIn.current = conversationId;
      try {
        localStream.current = await getMicrophone(); // before ringing anyone
      } catch (error) {
        startingIn.current = null;
        finish(null, 'failed', error instanceof Error ? error.message : 'Could not start the microphone.');
        return;
      }
      let call: Call;
      try {
        call = await startCallRequest(conversationId);
      } catch (error) {
        startingIn.current = null;
        finish(null, 'failed', toApiError(error).message);
        return;
      }
      startingIn.current = null;
      owned.current = call.id;
      setState({ phase: 'outgoing', call });
      startHeartbeat(call.id);
      timers.current.ring = setTimeout(() => {
        const now = stateRef.current;
        if (now.phase === 'outgoing' && now.call.id === call.id) void endAndFinish(now.call, 'no-answer');
      }, CALL_RING_TIMEOUT_SECONDS * 1000);
      // Join now, so we hear the callee's "ready" as soon as they answer.
      void connect(call, 'caller');
    },
    [connect, endAndFinish, finish, setState, startHeartbeat],
  );

  const accept = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== 'incoming' || current.answering) return;
    setState({ ...current, answering: true, error: null });
    try {
      localStream.current = await getMicrophone();
    } catch (error) {
      const now = stateRef.current;
      if (now.phase === 'incoming') setState({ ...now, answering: false, error: error instanceof Error ? error.message : 'Could not start the microphone.' });
      return;
    }
    owned.current = current.call.id;
    try {
      const call = await acceptCall(current.call.id);
      setState({ phase: 'connecting', call });
      startHeartbeat(call.id);
      void connect(call, 'callee');
    } catch (error) {
      release();
      const apiError = toApiError(error);
      if (apiError.code === 'CALL_ENDED' || apiError.status === 404) {
        refresh(current.call.id);
        finish(current.call, 'missed');
        return;
      }
      const now = stateRef.current;
      if (now.phase === 'incoming') setState({ ...now, answering: false, error: apiError.message });
    }
  }, [connect, finish, refresh, release, setState, startHeartbeat]);

  const decline = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== 'incoming') return;
    release();
    setState({ phase: 'idle' });
    await declineCall(current.call.id).catch(() => undefined);
  }, [release, setState]);

  const hangUp = useCallback(async () => {
    const current = stateRef.current;
    if (!isOngoingPhase(current) || current.phase === 'incoming') return;
    await endAndFinish(current.call, current.phase === 'outgoing' ? 'cancelled' : 'ended');
  }, [endAndFinish]);

  const rejoin = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== 'elsewhere') return;
    try {
      localStream.current = await getMicrophone();
    } catch (error) {
      finish(current.call, 'failed', error instanceof Error ? error.message : 'Could not start the microphone.');
      return;
    }
    const call = current.call;
    owned.current = call.id;
    const iCalled = call.initiatorId === myUserId;
    setState(call.status === 'ringing' ? { phase: 'outgoing', call } : { phase: 'connecting', call });
    startHeartbeat(call.id);
    void connect(call, iCalled ? 'caller' : 'callee');
  }, [connect, finish, myUserId, setState, startHeartbeat]);

  const toggleMute = useCallback(() => {
    setMuted((was) => {
      const next = !was;
      if (session.current) session.current.setMuted(next);
      else for (const track of localStream.current?.getAudioTracks() ?? []) track.enabled = !next;
      return next;
    });
  }, []);

  const dismiss = useCallback(() => {
    if (stateRef.current.phase === 'ended') setState({ phase: 'idle' });
  }, [setState]);

  const resync = useCallback(() => {
    const current = stateRef.current;
    listOngoingCalls().then(
      (calls) => {
        for (const call of calls) apply(call);
        // Our call ended while we were not listening: ask how.
        if (isOngoingPhase(current) && !calls.some((c) => c.id === current.call.id)) refresh(current.call.id);
      },
      () => undefined,
    );
  }, [apply, refresh]);

  // An incoming call stops ringing on its own after the ring timeout (the server agrees).
  const incomingId = state.phase === 'incoming' ? state.call.id : null;
  const incomingCreatedAt = state.phase === 'incoming' ? state.call.createdAt : null;
  useEffect(() => {
    if (!incomingId || !incomingCreatedAt) return;
    const left = new Date(incomingCreatedAt).getTime() + CALL_RING_TIMEOUT_SECONDS * 1000 - Date.now();
    const timer = setTimeout(() => {
      const current = stateRef.current;
      if (current.phase === 'incoming' && current.call.id === incomingId && !current.answering) finish(current.call, 'missed');
    }, Math.max(left, 5000));
    return () => clearTimeout(timer);
  }, [finish, incomingCreatedAt, incomingId]);

  // A caller who closes the page while it still rings stops ringing the other person. (An
  // active call is not ended on close: a reloaded page can rejoin it.)
  useEffect(() => {
    const onPageHide = () => {
      const current = stateRef.current;
      if (current.phase === 'outgoing' && owned.current === current.call.id) void endCall(current.call.id, { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // Signing out (or leaving the signed-in app) ends a call this tab is in.
  useEffect(() => {
    const t = timers.current;
    return () => {
      const current = stateRef.current;
      if (isOngoingPhase(current) && owned.current === current.call.id) void endCall(current.call.id, { keepalive: true }).catch(() => undefined);
      release();
      clearTimeout(t.notice);
    };
  }, [release]);

  useEffect(() => {
    resync();
  }, [resync]);

  const busy = state.phase !== 'idle' && state.phase !== 'ended';
  return useMemo(
    () => ({
      state,
      busy,
      muted,
      peerMuted,
      remoteStream,
      startCall,
      accept,
      decline,
      hangUp,
      rejoin,
      toggleMute,
      dismiss,
      handleCallUpdate: apply,
      resync,
    }),
    [accept, apply, busy, decline, dismiss, hangUp, muted, peerMuted, rejoin, remoteStream, resync, startCall, state, toggleMute],
  );
}

type Timer = ReturnType<typeof setTimeout> | undefined;
type Interval = ReturnType<typeof setInterval> | undefined;

export const CallsContext = createContext<CallsContextValue | null>(null);

/** Calls for the signed-in user. Available on every signed-in page. */
export function useCalls(): CallsContextValue {
  const value = useContext(CallsContext);
  if (!value) throw new Error('useCalls must be used inside the signed-in layout');
  return value;
}
