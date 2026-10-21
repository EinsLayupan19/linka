import { isAuthRetryableFetchError, type AuthError as SupabaseAuthError } from '@supabase/supabase-js';
import type { ForgotPasswordInput, LoginInput, RegisterInput, ResetPasswordInput } from '@linka/shared';
import { getSupabase } from '../lib/supabase';

/** An auth failure with a message that is safe and useful to show to the user. */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// Supabase Auth error codes -> user-facing messages.
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  email_not_confirmed: 'Confirm your email address first. Check your inbox for the link.',
  user_already_exists: 'An account with this email already exists. Try logging in instead.',
  weak_password: 'Choose a stronger password.',
  same_password: 'Choose a password different from your current one.',
  over_email_send_rate_limit: 'Too many emails were sent. Wait a few minutes and try again.',
  over_request_rate_limit: 'Too many attempts. Wait a moment and try again.',
  session_not_found: 'Your session has expired. Request a new link.',
};

function toAuthError(error: SupabaseAuthError): AuthError {
  if (isAuthRetryableFetchError(error)) {
    return new AuthError('Could not reach the authentication service. Check your connection and try again.');
  }
  const message = error.code ? MESSAGES[error.code] : undefined;
  if (message) return new AuthError(message, error.code);

  console.error('Unexpected auth error:', error.code ?? error.status, error.message);
  return new AuthError('Something went wrong. Please try again.', error.code);
}

/** Where email links (confirmation, password reset) send the user back to. */
const redirectUrl = (path: string) => `${window.location.origin}${path}`;

/**
 * Creates an account. When email confirmation is enabled in Supabase (recommended),
 * no session is returned until the user clicks the link in their inbox.
 */
export async function signUp(input: Pick<RegisterInput, 'email' | 'password'>): Promise<{ needsEmailConfirmation: boolean }> {
  const { data, error } = await getSupabase().auth.signUp({
    email: input.email,
    password: input.password,
    options: { emailRedirectTo: redirectUrl('/') },
  });
  if (error) throw toAuthError(error);
  return { needsEmailConfirmation: !data.session };
}

export async function signIn(input: LoginInput): Promise<void> {
  const { error } = await getSupabase().auth.signInWithPassword(input);
  if (error) throw toAuthError(error);
}

/** Signs out on this device and revokes this session's refresh token. */
export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut({ scope: 'local' });
  if (error) throw toAuthError(error);
}

/**
 * Sends a password reset link. Supabase answers the same way whether or not the email
 * has an account, so this never reveals who is registered.
 */
export async function requestPasswordReset(input: ForgotPasswordInput): Promise<void> {
  const { error } = await getSupabase().auth.resetPasswordForEmail(input.email, {
    redirectTo: redirectUrl('/reset-password'),
  });
  if (error) throw toAuthError(error);
}

/** Sets a new password for the signed-in user (after following a reset link). */
export async function updatePassword(input: Pick<ResetPasswordInput, 'password'>): Promise<void> {
  const { error } = await getSupabase().auth.updateUser({ password: input.password });
  if (error) throw toAuthError(error);
}
