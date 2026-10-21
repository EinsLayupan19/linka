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

export const supabaseState = { configured: true };

export const supabaseModule = {
  get isSupabaseConfigured() {
    return supabaseState.configured;
  },
  getSupabase: () => ({ auth: authMock }),
};
