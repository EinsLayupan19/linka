import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { authMock, fakeSession } from '../test/supabaseMock';
import { AuthError, requestPasswordReset, signIn, signOut, signOutOtherDevices, signUp, updatePassword } from './auth';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const ok = <T>(data: T) => ({ data, error: null });
const failed = (error: Error) => ({ data: { user: null, session: null }, error });

describe('signUp', () => {
  it('asks for email confirmation when Supabase returns no session', async () => {
    authMock.signUp.mockResolvedValue(ok({ user: { id: 'u' }, session: null }));

    await expect(signUp({ email: 'maya@example.test', password: 'correct horse' })).resolves.toEqual({
      needsEmailConfirmation: true,
    });
    expect(authMock.signUp).toHaveBeenCalledWith({
      email: 'maya@example.test',
      password: 'correct horse',
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
  });

  it('signs straight in when email confirmation is disabled', async () => {
    authMock.signUp.mockResolvedValue(ok({ user: { id: 'u' }, session: fakeSession() }));

    await expect(signUp({ email: 'maya@example.test', password: 'correct horse' })).resolves.toEqual({
      needsEmailConfirmation: false,
    });
  });

  it('turns weak-password errors into a readable message', async () => {
    authMock.signUp.mockResolvedValue(failed(new AuthApiError('Password is too weak', 422, 'weak_password')));

    await expect(signUp({ email: 'maya@example.test', password: 'password' })).rejects.toThrow(
      'Choose a stronger password.',
    );
  });

  // Supabase answers 500 "Database error saving new user" when something in the database (such
  // as a trigger on auth.users) rejects the new account. The insert is rolled back: no account.
  it('explains a database failure during sign-up, and that no account was created', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    authMock.signUp.mockResolvedValue(
      failed(new AuthApiError('Database error saving new user', 500, 'unexpected_failure')),
    );

    const error = await signUp({ email: 'maya@example.test', password: 'correct horse' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toBe(
      'We could not create your account because of a problem on our side. No account was created. Please try again later.',
    );
    expect((error as AuthError).code).toBe('signup_database_error');
    // Logged for whoever runs the site, without the person's email address.
    expect(consoleError).toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('maya@example.test');
  });

  it('keeps other unexpected sign-up failures generic', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authMock.signUp.mockResolvedValue(failed(new AuthApiError('internal: something odd', 500, 'unexpected_failure')));

    await expect(signUp({ email: 'maya@example.test', password: 'correct horse' })).rejects.toThrow(
      'Something went wrong. Please try again.',
    );
  });

  it('explains when confirmation emails cannot be sent to the address', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authMock.signUp.mockResolvedValue(
      failed(new AuthApiError('Email address "x" cannot be used as it is not authorized', 400, 'email_address_not_authorized')),
    );

    await expect(signUp({ email: 'maya@example.test', password: 'correct horse' })).rejects.toThrow(
      'We cannot send email to this address right now, so sign-up could not finish. Please try again later.',
    );
  });

  it.each([
    ['email_exists', 'An account with this email already exists. Try logging in instead.'],
    ['user_already_exists', 'An account with this email already exists. Try logging in instead.'],
    ['email_address_invalid', 'This email address cannot be used. Check it or use another one.'],
    ['signup_disabled', 'New sign-ups are turned off at the moment.'],
    ['validation_failed', 'Check your email address and password, then try again.'],
    ['over_email_send_rate_limit', 'Too many emails were sent. Wait a few minutes and try again.'],
  ])('maps the "%s" sign-up error to a clear message', async (code, message) => {
    authMock.signUp.mockResolvedValue(failed(new AuthApiError('raw message', 400, code)));

    await expect(signUp({ email: 'maya@example.test', password: 'correct horse' })).rejects.toThrow(message);
  });

  it('reports a network failure during sign-up as a connection problem', async () => {
    authMock.signUp.mockResolvedValue(failed(new AuthRetryableFetchError('Failed to fetch', 0)));
    await expect(signUp({ email: 'maya@example.test', password: 'correct horse' })).rejects.toThrow(/Could not reach/);
  });
});

describe('signIn', () => {
  it('passes the credentials to Supabase', async () => {
    authMock.signInWithPassword.mockResolvedValue(ok({ user: {}, session: fakeSession() }));

    await signIn({ email: 'maya@example.test', password: 'secret-pass' });
    expect(authMock.signInWithPassword).toHaveBeenCalledWith({ email: 'maya@example.test', password: 'secret-pass' });
  });

  it('does not reveal which part of the credentials was wrong', async () => {
    authMock.signInWithPassword.mockResolvedValue(
      failed(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')),
    );

    const error = await signIn({ email: 'maya@example.test', password: 'wrong' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toBe('Email or password is incorrect.');
  });

  it('explains unconfirmed emails', async () => {
    authMock.signInWithPassword.mockResolvedValue(
      failed(new AuthApiError('Email not confirmed', 400, 'email_not_confirmed')),
    );
    await expect(signIn({ email: 'maya@example.test', password: 'x' })).rejects.toThrow(/Confirm your email/);
  });

  it('reports network failures as a connection problem', async () => {
    authMock.signInWithPassword.mockResolvedValue(failed(new AuthRetryableFetchError('Failed to fetch', 0)));
    await expect(signIn({ email: 'maya@example.test', password: 'x' })).rejects.toThrow(/Could not reach/);
  });

  it('hides unexpected Supabase messages behind a generic one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authMock.signInWithPassword.mockResolvedValue(
      failed(new AuthApiError('internal: relation "x" does not exist', 500, 'unexpected_failure')),
    );
    await expect(signIn({ email: 'maya@example.test', password: 'x' })).rejects.toThrow(
      'Something went wrong. Please try again.',
    );
  });
});

describe('signOut / password reset', () => {
  it('signs out of this device only', async () => {
    await signOut();
    expect(authMock.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('can sign out of every device, this one included', async () => {
    await signOut({ everywhere: true });
    expect(authMock.signOut).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('can sign out of every other device, keeping this one', async () => {
    await signOutOtherDevices();
    expect(authMock.signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('reports a failure to sign out other devices as a connection problem when offline', async () => {
    authMock.signOut.mockResolvedValueOnce({ error: new AuthRetryableFetchError('Failed to fetch', 0) } as never);
    await expect(signOutOtherDevices()).rejects.toThrow(/Could not reach/);
  });

  it('sends reset links back to the reset page', async () => {
    authMock.resetPasswordForEmail.mockResolvedValue(ok({}));

    await requestPasswordReset({ email: 'maya@example.test' });
    expect(authMock.resetPasswordForEmail).toHaveBeenCalledWith('maya@example.test', {
      redirectTo: `${window.location.origin}/reset-password`,
    });
  });

  it('reports rate limits on reset emails', async () => {
    authMock.resetPasswordForEmail.mockResolvedValue(
      failed(new AuthApiError('Rate limit', 429, 'over_email_send_rate_limit')),
    );
    await expect(requestPasswordReset({ email: 'maya@example.test' })).rejects.toThrow(/Too many emails/);
  });

  it('updates the password and maps "same password"', async () => {
    authMock.updateUser.mockResolvedValueOnce(ok({ user: {} }));
    await updatePassword({ password: 'brand new pass' });
    expect(authMock.updateUser).toHaveBeenCalledWith({ password: 'brand new pass' });

    authMock.updateUser.mockResolvedValueOnce(failed(new AuthApiError('Same password', 422, 'same_password')));
    await expect(updatePassword({ password: 'brand new pass' })).rejects.toThrow(/different from your current/);
  });
});
