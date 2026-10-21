import { describe, expect, it } from 'vitest';
import { looksLikeSecretKey, parseEnv } from './env';

// Builds an unsigned JWT-shaped string with the given payload (signature is irrelevant here).
function fakeJwt(payload: object): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('looksLikeSecretKey', () => {
  it('flags new-style secret keys', () => {
    expect(looksLikeSecretKey('sb_secret_abc123')).toBe(true);
  });

  it('flags legacy service_role JWTs', () => {
    expect(looksLikeSecretKey(fakeJwt({ role: 'service_role' }))).toBe(true);
  });

  it('allows publishable and anon keys', () => {
    expect(looksLikeSecretKey('sb_publishable_abc123')).toBe(false);
    expect(looksLikeSecretKey(fakeJwt({ role: 'anon' }))).toBe(false);
  });
});

describe('parseEnv', () => {
  it('defaults the API URL and treats empty Supabase values as not set', () => {
    expect(parseEnv({ VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' })).toEqual({
      VITE_API_URL: 'http://localhost:3000',
      VITE_SUPABASE_URL: undefined,
      VITE_SUPABASE_PUBLISHABLE_KEY: undefined,
    });
  });

  it('strips a trailing slash from the API URL', () => {
    expect(parseEnv({ VITE_API_URL: 'https://api.linka.app/' }).VITE_API_URL).toBe('https://api.linka.app');
  });

  it('refuses to start with a secret key in the frontend', () => {
    expect(() => parseEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc123' })).toThrow(/SECRET key/);
  });
});
