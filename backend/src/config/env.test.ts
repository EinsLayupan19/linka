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

  it('treats SUPABASE_SECRET_KEY as optional in development and required in production', () => {
    expect(parseEnv({ SUPABASE_SECRET_KEY: '' }).SUPABASE_SECRET_KEY).toBeUndefined();
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it('refuses the publishable key (or anything too short) as SUPABASE_SECRET_KEY, without echoing it', () => {
    const publishable = 'sb_publishable_abcdefghijklmnopqrstuvwxyz';
    expect(() => parseEnv({ SUPABASE_SECRET_KEY: publishable })).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/SUPABASE_SECRET_KEY/) }),
    );
    expect(() => parseEnv({ SUPABASE_SECRET_KEY: publishable })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(publishable) }),
    );
    expect(() => parseEnv({ SUPABASE_SECRET_KEY: 'short' })).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it('defaults ICE_SERVERS to a public STUN server and accepts a JSON list', () => {
    expect(parseEnv({}).ICE_SERVERS).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    expect(parseEnv({ ICE_SERVERS: '' }).ICE_SERVERS).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    const turn = '[{"urls":["turn:turn.example.com:3478"],"username":"u","credential":"s3cret-turn"}]';
    expect(parseEnv({ ICE_SERVERS: turn }).ICE_SERVERS).toEqual(JSON.parse(turn));
  });

  it('rejects invalid ICE_SERVERS without echoing them', () => {
    for (const value of ['not json s3cret-turn', '[]', '[{"urls":"http://s3cret-turn.example.com"}]']) {
      expect(() => parseEnv({ ICE_SERVERS: value })).toThrow(
        expect.objectContaining({ message: expect.stringMatching(/ICE_SERVERS/) }),
      );
      expect(() => parseEnv({ ICE_SERVERS: value })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('s3cret-turn') }),
      );
    }
  });

  it('never includes variable values in the error message', () => {
    const secret = 'mysql://admin:SuperSecret123@host/db';

    expect(() => parseEnv({ DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('SuperSecret123') }),
    );
  });
});
