import { createContext, useContext } from 'react';
import type { Session } from '@supabase/supabase-js';

export type AuthState =
  /** Waiting for Supabase to restore the session from storage. */
  | { status: 'loading' }
  /** VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set. */
  | { status: 'unconfigured' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; session: Session };

export interface AuthContextValue {
  state: AuthState;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
