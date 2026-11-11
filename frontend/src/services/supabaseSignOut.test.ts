import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

/**
 * How the installed supabase-js (auth-js 2.118.0) behaves when a sign-out request to Supabase
 * fails. Not Linka code: these pin down the library behavior that services/auth.ts relies on, so
 * an upgrade that changes it fails here first. Uses the real client; only the network is fake.
 *
 * - scope 'global' and 'local' remove THIS device's session even when the server call fails
 * - scope 'others' never removes this device's session
 * That is why "Log out of all devices" revokes the others first and signs out here only after.
 */
const STORAGE_KEY = 'linka-test-auth';

function clientWithSession(logout: () => Promise<Response>) {
  const stored = new Map<string, string>();
  stored.set(
    STORAGE_KEY,
    JSON.stringify({
      access_token: 'header.eyJzdWIiOiJ1In0.signature',
      refresh_token: 'refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: '3f2b8c1e-7a4d-4e9b-9c2a-1d5e8f7a6b3c', email: 'maya@example.test' },
    }),
  );
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/auth/v1/logout')) return logout();
    throw new Error(`unexpected request ${String(input)}`);
  });
  const client = createClient('https://abcdefghijklmnop.supabase.co', 'sb_publishable_test_key', {
    auth: {
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => void stored.set(key, value),
        removeItem: (key) => void stored.delete(key),
      },
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchMock as unknown as typeof fetch },
  });
  return { client, fetchMock, hasSession: () => stored.has(STORAGE_KEY) };
}

const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const serverError = async () => new Response(JSON.stringify({ msg: 'unavailable' }), { status: 503 });
const ok = async () => new Response(null, { status: 204 });

describe('installed supabase-js: sign-out when the request to Supabase fails', () => {
  it.each([
    ['offline', offline],
    ['a server error', serverError],
  ])("scope 'global' still drops this device's session (%s), while nothing was revoked", async (_label, logout) => {
    const { client, fetchMock, hasSession } = clientWithSession(logout);

    const { error } = await client.auth.signOut({ scope: 'global' });

    expect(error).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/logout?scope=global'), expect.anything());
    expect(hasSession()).toBe(false);
  });

  it.each([
    ['offline', offline],
    ['a server error', serverError],
  ])("scope 'others' keeps this device's session (%s)", async (_label, logout) => {
    const { client, hasSession } = clientWithSession(logout);

    const { error } = await client.auth.signOut({ scope: 'others' });

    expect(error).not.toBeNull();
    expect(hasSession()).toBe(true);
  });

  it("scope 'others' keeps this device's session when it succeeds too", async () => {
    const { client, hasSession } = clientWithSession(ok);

    const { error } = await client.auth.signOut({ scope: 'others' });

    expect(error).toBeNull();
    expect(hasSession()).toBe(true);
  });

  it("scope 'local' drops this device's session, even offline (an ordinary log out always works here)", async () => {
    const { client, hasSession } = clientWithSession(offline);

    await client.auth.signOut({ scope: 'local' });

    expect(hasSession()).toBe(false);
  });
});
