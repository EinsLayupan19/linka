import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthContext, type AuthState } from '../../hooks/useAuth';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';

/**
 * Tracks the Supabase session for the whole app.
 * supabase-js persists the session and refreshes the access token on its own;
 * this provider only mirrors its auth events into React state.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    isSupabaseConfigured ? { status: 'loading' } : { status: 'unconfigured' },
  );

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    // Fires INITIAL_SESSION right away, then SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED,
    // PASSWORD_RECOVERY (from a reset link), etc.
    // Keep this callback synchronous: awaiting Supabase calls inside it can deadlock.
    const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
      setState(session ? { status: 'signed_in', session } : { status: 'signed_out' });
    });

    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo(() => ({ state }), [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
