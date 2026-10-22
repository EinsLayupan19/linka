import type { Session } from '@supabase/supabase-js';
import { vi } from 'vitest';

/**
 * A stand-in for lib/supabase. Use it in a test file with:
 *   vi.mock('<path>/lib/supabase', async () => (await import('<path>/test/supabaseMock')).supabaseModule);
 * Mocks are reset after every test (see setup.ts), so each test starts from these defaults.
 */

export const TEST_USER_ID = '3f2b8c1e-7a4d-4e9b-9c2a-1d5e8f7a6b3c';

export function fakeSession(overrides: { accessToken?: string; email?: string } = {}): Session {
  return {
    access_token: overrides.accessToken ?? 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id: TEST_USER_ID, email: overrides.email ?? 'maya@example.test' },
  } as unknown as Session;
}

export const authMock = {
  getSession: vi.fn(async () => ({ data: { session: fakeSession() as Session | null }, error: null })),
  onAuthStateChange: vi.fn((_callback: (event: string, session: Session | null) => void) => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  })),
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
};

type StatusCallback = (status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED') => void;
type BroadcastHandler = (message: { payload: unknown }) => void;

/** A fake Realtime channel that tests drive by hand. */
export interface FakeChannel {
  topic: string;
  options: unknown;
  removed: boolean;
  /** The server accepted (or re-accepted) the join. */
  join(): void;
  /** The connection dropped or the join was refused. */
  fail(status?: 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'): void;
  /** Deliver a broadcast event to the channel's listeners. */
  emit(event: string, payload: unknown): void;
  /** Replace the presence state and notify presence listeners (a Presence 'sync'). */
  setPresence(state: Record<string, unknown[]>): void;
  /** What this client tracked in Presence. */
  tracked: unknown[];
  /** Broadcasts this client sent. */
  sent: { event: string; payload: unknown }[];
}

export const realtimeChannels: FakeChannel[] = [];

function createFakeChannel(topic: string, options: unknown) {
  const handlers: { type: string; event: string; handler: BroadcastHandler }[] = [];
  let onStatus: StatusCallback | undefined;
  let presence: Record<string, unknown[]> = {};

  const fake: FakeChannel = {
    topic,
    options,
    removed: false,
    join: () => onStatus?.('SUBSCRIBED'),
    fail: (status = 'CHANNEL_ERROR') => onStatus?.(status),
    emit: (event, payload) => {
      for (const h of handlers) if (h.type === 'broadcast' && h.event === event) h.handler({ payload });
    },
    setPresence: (state) => {
      presence = state;
      for (const h of handlers) if (h.type === 'presence' && h.event === 'sync') h.handler({ payload: undefined });
    },
    tracked: [],
    sent: [],
  };

  const channel = {
    on: vi.fn((type: string, filter: { event: string }, handler: BroadcastHandler) => {
      handlers.push({ type, event: filter.event, handler });
      return channel;
    }),
    presenceState: () => presence,
    track: vi.fn(async (state: unknown) => {
      fake.tracked.push(state);
      return 'ok';
    }),
    send: vi.fn(async (message: { event: string; payload: unknown }) => {
      fake.sent.push({ event: message.event, payload: message.payload });
      return 'ok';
    }),
    subscribe: vi.fn((callback: StatusCallback) => {
      onStatus = callback;
      return channel;
    }),
    __fake: fake,
  };
  realtimeChannels.push(fake);
  return channel;
}

export const realtimeMock = {
  channel: vi.fn((topic: string, options: unknown) => createFakeChannel(topic, options)),
  removeChannel: vi.fn(async (channel: { __fake: FakeChannel }) => {
    channel.__fake.removed = true;
    return 'ok';
  }),
  setAuth: vi.fn(async () => undefined),
};

/** The fake channel most recently opened for `topic`. */
export function latestChannel(topic?: string): FakeChannel {
  const matches = topic ? realtimeChannels.filter((c) => c.topic === topic) : realtimeChannels;
  const channel = matches.at(-1);
  if (!channel) throw new Error(`No realtime channel${topic ? ` for ${topic}` : ''} was opened`);
  return channel;
}

export const supabaseState = { configured: true };

export const supabaseModule = {
  get isSupabaseConfigured() {
    return supabaseState.configured;
  },
  getSupabase: () => ({
    auth: authMock,
    channel: realtimeMock.channel,
    removeChannel: realtimeMock.removeChannel,
    realtime: { setAuth: realtimeMock.setAuth },
  }),
};
