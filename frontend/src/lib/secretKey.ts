/**
 * Detects Supabase keys that must never ship to the browser:
 * new-style secret keys (sb_secret_...) and legacy service_role JWTs.
 *
 * No imports and no side effects, so both the app (lib/env.ts) and the build (vite.config.ts,
 * via lib/buildEnv.ts) can use it.
 */
export function looksLikeSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;

  const payload = key.split('.')[1];
  if (!payload) return false;
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims === 'object' && claims !== null && 'role' in claims && claims.role === 'service_role';
  } catch {
    return false;
  }
}
