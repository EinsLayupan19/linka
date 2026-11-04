import { describe, expect, it } from 'vitest';
import { assertBuildEnv, buildEnvProblems } from './buildEnv';

const hosted = {
  VITE_API_URL: 'https://linka-api.example.com',
  VITE_SUPABASE_URL: 'https://abc.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnop',
};

describe('buildEnvProblems (checked when the production bundle is built)', () => {
  it('accepts a hosted configuration', () => {
    expect(buildEnvProblems(hosted)).toEqual([]);
  });

  it('accepts a local build against a local API', () => {
    expect(buildEnvProblems({ ...hosted, VITE_API_URL: 'http://localhost:3000' })).toEqual([]);
    expect(buildEnvProblems({ ...hosted, VITE_API_URL: 'http://127.0.0.1:3000' })).toEqual([]);
  });

  it('requires every variable, instead of quietly falling back to localhost', () => {
    expect(buildEnvProblems({})).toEqual([
      'VITE_API_URL is not set',
      'VITE_SUPABASE_URL is not set',
      'VITE_SUPABASE_PUBLISHABLE_KEY is not set',
    ]);
    expect(buildEnvProblems({ ...hosted, VITE_API_URL: '' })).toEqual(['VITE_API_URL is not set']);
  });

  it('requires https for hosted addresses (browsers block http calls from an https page)', () => {
    expect(buildEnvProblems({ ...hosted, VITE_API_URL: 'http://linka-api.example.com' })).toEqual([
      'VITE_API_URL must start with https:// (only localhost may use http://)',
    ]);
    expect(buildEnvProblems({ ...hosted, VITE_SUPABASE_URL: 'http://abc.supabase.co' })).toEqual([
      'VITE_SUPABASE_URL must start with https:// (only localhost may use http://)',
    ]);
  });

  it('rejects values that are not addresses, or that include a path', () => {
    expect(buildEnvProblems({ ...hosted, VITE_API_URL: 'linka-api.example.com' })).toEqual([
      'VITE_API_URL is not a valid URL',
    ]);
    expect(buildEnvProblems({ ...hosted, VITE_API_URL: 'https://linka-api.example.com/api' })).toEqual([
      'VITE_API_URL must be the address only, without a path (the app adds /api/...)',
    ]);
  });

  it('refuses a Supabase secret key before it can be bundled into public JavaScript, without printing it', () => {
    const secret = 'sb_secret_do-not-ship-this-0123456789';
    const problems = buildEnvProblems({ ...hosted, VITE_SUPABASE_PUBLISHABLE_KEY: secret });
    expect(problems).toEqual([
      'VITE_SUPABASE_PUBLISHABLE_KEY is a SECRET key; use the publishable (or anon) key',
    ]);
    expect(problems.join('\n')).not.toContain(secret);
  });
});

describe('assertBuildEnv', () => {
  it('throws one message naming every problem, and passes silently otherwise', () => {
    expect(() => assertBuildEnv(hosted)).not.toThrow();
    expect(() => assertBuildEnv({ VITE_SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(
      /VITE_API_URL is not set[\s\S]*VITE_SUPABASE_PUBLISHABLE_KEY is not set/,
    );
  });
});
