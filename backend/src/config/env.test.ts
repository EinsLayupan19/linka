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

  it('accepts an origin copied with a trailing slash (browsers send it without one)', () => {
    expect(parseEnv({ CORS_ORIGIN: 'https://linka.example.com/' }).CORS_ORIGIN).toEqual(['https://linka.example.com']);
  });

  it('rejects a CORS origin with a path, which could never match a browser origin', () => {
    expect(() => parseEnv({ CORS_ORIGIN: 'https://linka.example.com/app' })).toThrow(/CORS_ORIGIN/);
  });

  describe('in production', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pw@db.example.com:5432/postgres',
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_abcdefghijklmnopqrstuvwxyz',
    };

    it('starts with every required value set', () => {
      const env = parseEnv({ ...production, CORS_ORIGIN: 'https://linka.example.com' });
      expect(env.CORS_ORIGIN).toEqual(['https://linka.example.com']);
    });

    // The error lists each problem as "✖ <rule>" followed by "→ at <VARIABLE>".
    it('requires CORS_ORIGIN to be set (the localhost default would block the real site)', () => {
      expect(() => parseEnv(production)).toThrow(/required in production\s+→ at CORS_ORIGIN/);
      expect(() => parseEnv({ ...production, CORS_ORIGIN: '' })).toThrow(/required in production\s+→ at CORS_ORIGIN/);
    });

    it('requires https for CORS origins and SUPABASE_URL', () => {
      expect(() => parseEnv({ ...production, CORS_ORIGIN: 'http://linka.example.com' })).toThrow(
        /https:\/\/ in production\s+→ at CORS_ORIGIN/,
      );
      expect(() =>
        parseEnv({ ...production, CORS_ORIGIN: 'https://linka.example.com', SUPABASE_URL: 'http://abc.supabase.co' }),
      ).toThrow(/https:\/\/ in production\s+→ at SUPABASE_URL/);
    });
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

  it('trusts no proxy by default, and accepts a number of proxy hops', () => {
    expect(parseEnv({}).TRUST_PROXY).toBe(0);
    expect(parseEnv({ TRUST_PROXY: '' }).TRUST_PROXY).toBe(0);
    expect(parseEnv({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    for (const value of ['-1', 'yes', '1.5', '11']) {
      expect(() => parseEnv({ TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    }
  });

  it('never includes variable values in the error message', () => {
    const secret = 'mysql://admin:SuperSecret123@host/db';

    expect(() => parseEnv({ DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('SuperSecret123') }),
    );
  });
});
