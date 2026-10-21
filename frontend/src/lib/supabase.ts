import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

export const isSupabaseConfigured = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY);

let client: SupabaseClient | undefined;

/**
 * The browser Supabase client. It only ever uses the public publishable key;
 * what each user may read or write is enforced by RLS and the API.
 * Created on first use so the app still runs before credentials are configured.
 */
export function getSupabase(): SupabaseClient {
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in frontend/.env.',
    );
  }
  client ??= createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      // Keep the session in localStorage across reloads and refresh tokens before they expire.
      persistSession: true,
      autoRefreshToken: true,
      // Pick up the session from email links (confirmation and password reset).
      detectSessionInUrl: true,
    },
  });
  return client;
}
