import { looksLikeSecretKey } from './secretKey.ts';

/**
 * Checks run by `vite build` (see vite.config.ts), before anything is bundled.
 *
 * In development lib/env.ts falls back to a local API, which is convenient there but would make
 * a hosted site quietly call http://localhost:3000 (the visitor's own computer) if VITE_API_URL
 * was forgotten. And every VITE_ value is copied into the public JavaScript, so a secret key must
 * be refused here: refusing it only when the app starts would be too late, it is already published.
 *
 * Messages name the variable and the rule, never the value.
 */
export function buildEnvProblems(source: Record<string, string | undefined>): string[] {
  const problems: string[] = [];

  for (const name of ['VITE_API_URL', 'VITE_SUPABASE_URL'] as const) {
    const value = source[name];
    if (!value) {
      problems.push(`${name} is not set`);
      continue;
    }
    if (!URL.canParse(value)) {
      problems.push(`${name} is not a valid URL`);
      continue;
    }
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
      problems.push(`${name} must start with https:// (only localhost may use http://)`);
    } else if (url.pathname.replace(/\/+$/, '') !== '' || url.search || url.hash) {
      problems.push(`${name} must be the address only, without a path (the app adds /api/...)`);
    }
  }

  const key = source.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!key) problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is not set');
  else if (looksLikeSecretKey(key)) {
    problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is a SECRET key; use the publishable (or anon) key');
  }

  return problems;
}

/** Throws one readable error listing every problem; does nothing when there are none. */
export function assertBuildEnv(source: Record<string, string | undefined>): void {
  const problems = buildEnvProblems(source);
  if (problems.length === 0) return;
  throw new Error(
    `Cannot build the frontend: fix these environment variables (frontend/.env locally, or the hosting dashboard):\n` +
      problems.map((problem) => `  - ${problem}`).join('\n'),
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
