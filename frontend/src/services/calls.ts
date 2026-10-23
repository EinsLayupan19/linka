import { callListSchema, callSchema, iceServersResponseSchema, type Call, type IceServer } from '@linka/shared';
import { z } from 'zod';
import { apiRequest } from '../lib/api';

/**
 * The call lifecycle, owned by the API (start, answer, decline, hang up). The audio itself goes
 * browser to browser over WebRTC (services/webrtc.ts); the API never sees it.
 */

const callPath = (callId: string) => `/api/calls/${encodeURIComponent(callId)}`;

export function startCall(conversationId: string): Promise<Call> {
  return apiRequest('/api/calls', callSchema, { auth: true, method: 'POST', json: { conversationId, type: 'voice' } });
}

export function acceptCall(callId: string): Promise<Call> {
  return apiRequest(`${callPath(callId)}/accept`, callSchema, { auth: true, method: 'POST' });
}

export function declineCall(callId: string): Promise<Call> {
  return apiRequest(`${callPath(callId)}/decline`, callSchema, { auth: true, method: 'POST' });
}

/** Hang up, cancel or refuse. Safe to repeat. `keepalive` lets it finish while the page closes. */
export function endCall(callId: string, options: { keepalive?: boolean } = {}): Promise<Call> {
  return apiRequest(`${callPath(callId)}/end`, callSchema, { auth: true, method: 'POST', keepalive: options.keepalive ?? false });
}

export function sendCallHeartbeat(callId: string): Promise<void> {
  return apiRequest(`${callPath(callId)}/heartbeat`, z.undefined(), { auth: true, method: 'POST' });
}

export function getCall(callId: string): Promise<Call> {
  return apiRequest(callPath(callId), callSchema, { auth: true });
}

/** Ringing and active calls the user takes part in (after a reload or a reconnect). */
export async function listOngoingCalls(): Promise<Call[]> {
  return (await apiRequest('/api/calls/ongoing', callListSchema, { auth: true })).calls;
}

let iceServers: Promise<IceServer[]> | null = null;

/** STUN/TURN servers from the API, fetched once per page. Without them, only direct (same-network) connections work. */
export function getIceServers(): Promise<IceServer[]> {
  iceServers ??= apiRequest('/api/calls/ice-servers', iceServersResponseSchema, { auth: true }).then(
    (response) => response.iceServers,
    () => {
      iceServers = null; // try again next call
      return [];
    },
  );
  return iceServers;
}
