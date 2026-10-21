import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

describe('parseEnv', () => {
  it('applies development defaults', () => {
    const env = parseEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGIN).toEqual(['http://localhost:5173']);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('treats an empty DATABASE_URL as not set', () => {
    expect(parseEnv({ DATABASE_URL: '' }).DATABASE_URL).toBeUndefined();
  });

  it('splits a comma-separated CORS_ORIGIN', () => {
    const env = parseEnv({ CORS_ORIGIN: 'https://linka.app, https://www.linka.app' });

    expect(env.CORS_ORIGIN).toEqual(['https://linka.app', 'https://www.linka.app']);
  });

  it('rejects an invalid CORS origin', () => {
    expect(() => parseEnv({ CORS_ORIGIN: 'not a url' })).toThrow(/CORS_ORIGIN/);
  });

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://user@host/db' })).toThrow(/DATABASE_URL/);
  });

  it('requires DATABASE_URL and SUPABASE_URL in production', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL[\s\S]*SUPABASE_URL/);
  });

  it('accepts SUPABASE_URL without a trailing slash and treats empty as not set', () => {
    expect(parseEnv({ SUPABASE_URL: 'https://abc.supabase.co/' }).SUPABASE_URL).toBe('https://abc.supabase.co');
    expect(parseEnv({ SUPABASE_URL: '' }).SUPABASE_URL).toBeUndefined();
  });

  it('rejects an invalid SUPABASE_URL', () => {
    expect(() => parseEnv({ SUPABASE_URL: 'abc.supabase' })).toThrow(/SUPABASE_URL/);
  });

  it('never includes variable values in the error message', () => {
    const secret = 'mysql://admin:SuperSecret123@host/db';

    expect(() => parseEnv({ DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('SuperSecret123') }),
    );
  });
});
