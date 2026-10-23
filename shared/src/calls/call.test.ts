import { describe, expect, it } from 'vitest';
import { callSignalSchema, callTopic } from '../realtime/events.js';
import { createCallSchema, iceServersResponseSchema, isOngoingCall } from './call.js';

const callId = '6a1c3e5f-7b9d-4f2a-8c4e-0d2f4a6c8e1b';
const from = '8e0a2c4d-6f8b-4a1c-9e3d-5f7b9d1f3a5c';
const base = { callId, from, session: 'session-a1b2c3d4' };

describe('createCallSchema', () => {
  it('accepts a voice call in a conversation', () => {
    expect(createCallSchema.parse({ conversationId: callId, type: 'voice' })).toEqual({ conversationId: callId, type: 'voice' });
  });

  it('refuses video (Phase 8), unknown fields and bad ids', () => {
    expect(createCallSchema.safeParse({ conversationId: callId, type: 'video' }).success).toBe(false);
    expect(createCallSchema.safeParse({ conversationId: callId, type: 'voice', initiatorId: from }).success).toBe(false);
    expect(createCallSchema.safeParse({ conversationId: 'x', type: 'voice' }).success).toBe(false);
  });
});

describe('ICE servers', () => {
  it('accepts STUN and TURN URLs only', () => {
    expect(iceServersResponseSchema.safeParse({ iceServers: [{ urls: 'stun:stun.test:3478' }] }).success).toBe(true);
    expect(
      iceServersResponseSchema.safeParse({ iceServers: [{ urls: ['turns:turn.test:443'], username: 'u', credential: 'c' }] }).success,
    ).toBe(true);
    expect(iceServersResponseSchema.safeParse({ iceServers: [{ urls: 'https://evil.test' }] }).success).toBe(false);
    expect(iceServersResponseSchema.safeParse({ iceServers: [{ urls: [] }] }).success).toBe(false);
  });
});

describe('call signals', () => {
  it.each([
    { kind: 'ready', ...base },
    { kind: 'offer', ...base, to: 'session-e5f6a7b8', connection: 'conn-12345678', sdp: 'v=0\r\n' },
    { kind: 'answer', ...base, to: 'session-e5f6a7b8', connection: 'conn-12345678', sdp: 'v=0\r\n' },
    { kind: 'ice', ...base, to: 'session-e5f6a7b8', connection: 'conn-12345678', candidates: [{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 }] },
    { kind: 'media', ...base, muted: true },
    { kind: 'bye', ...base, to: 'session-e5f6a7b8' },
  ])('accepts a valid $kind', (signal) => {
    expect(callSignalSchema.safeParse(signal).success).toBe(true);
  });

  it.each([
    ['an unknown kind', { kind: 'video-on', ...base }],
    ['an offer without a target session', { kind: 'offer', ...base, connection: 'conn-12345678', sdp: 'v=0' }],
    ['an offer without a connection', { kind: 'offer', ...base, to: 'session-e5f6a7b8', sdp: 'v=0' }],
    ['an empty SDP', { kind: 'answer', ...base, to: 'session-e5f6a7b8', connection: 'conn-12345678', sdp: '' }],
    ['an oversized SDP', { kind: 'offer', ...base, to: 'session-e5f6a7b8', connection: 'conn-12345678', sdp: 'x'.repeat(100_001) }],
    ['too many candidates', { kind: 'ice', ...base, to: 'session-e5f6a7b8', connection: 'conn-12345678', candidates: Array.from({ length: 51 }, () => ({ candidate: 'c' })) }],
    ['no candidates', { kind: 'ice', ...base, to: 'session-e5f6a7b8', connection: 'conn-12345678', candidates: [] }],
    ['a malformed session', { kind: 'ready', ...base, session: 'x' }],
    ['a sender that is not a user id', { kind: 'ready', ...base, from: 'someone' }],
  ])('rejects %s', (_label, signal) => {
    expect(callSignalSchema.safeParse(signal).success).toBe(false);
  });

  it('names the topic after the call', () => {
    expect(callTopic(callId)).toBe(`call:${callId}`);
  });

  it('knows which calls are ongoing', () => {
    expect(isOngoingCall({ status: 'ringing' })).toBe(true);
    expect(isOngoingCall({ status: 'active' })).toBe(true);
    expect(isOngoingCall({ status: 'missed' })).toBe(false);
  });
});
