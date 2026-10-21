import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../services/auth';
import * as authService from '../services/auth';
import { renderWithAuth, signedIn } from '../test/render';
import { ForgotPassword } from './ForgotPassword';
import { Login } from './Login';
import { Register } from './Register';
import { ResetPassword } from './ResetPassword';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);
vi.mock('../services/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof authService>()),
  signIn: vi.fn(),
  signUp: vi.fn(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
}));

const signedOut = { status: 'signed_out' } as const;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('Login', () => {
  it('validates before contacting Supabase', async () => {
    renderWithAuth(<Login />, { auth: signedOut });
    submit('Log in');

    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(authService.signIn).not.toHaveBeenCalled();
  });

  it('signs in with the trimmed email', async () => {
    vi.mocked(authService.signIn).mockResolvedValue();
    renderWithAuth(<Login />, { auth: signedOut });

    type('Email', '  maya@example.test ');
    type('Password', 'correct horse');
    submit('Log in');

    await waitFor(() =>
      expect(authService.signIn).toHaveBeenCalledWith({ email: 'maya@example.test', password: 'correct horse' }),
    );
  });

  it('shows the sign-in error and re-enables the form', async () => {
    vi.mocked(authService.signIn).mockRejectedValue(new AuthError('Email or password is incorrect.'));
    renderWithAuth(<Login />, { auth: signedOut });

    type('Email', 'maya@example.test');
    type('Password', 'wrong');
    submit('Log in');

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
  });
});

describe('Register', () => {
  it('checks password length and confirmation', async () => {
    renderWithAuth(<Register />, { auth: signedOut });
    type('Email', 'maya@example.test');
    type('Password', 'short');
    type('Confirm password', 'other');
    submit('Create account');

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(authService.signUp).not.toHaveBeenCalled();
  });

  it('asks the user to confirm their email after signing up', async () => {
    vi.mocked(authService.signUp).mockResolvedValue({ needsEmailConfirmation: true });
    renderWithAuth(<Register />, { auth: signedOut });

    type('Email', 'maya@example.test');
    type('Password', 'correct horse');
    type('Confirm password', 'correct horse');
    submit('Create account');

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('maya@example.test')).toBeInTheDocument();
    expect(authService.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'maya@example.test', password: 'correct horse' }),
    );
  });

  it('shows sign-up errors', async () => {
    vi.mocked(authService.signUp).mockRejectedValue(new AuthError('Choose a stronger password.'));
    renderWithAuth(<Register />, { auth: signedOut });

    type('Email', 'maya@example.test');
    type('Password', 'password1');
    type('Confirm password', 'password1');
    submit('Create account');

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a stronger password.');
  });
});

describe('ForgotPassword', () => {
  it('confirms with the same message whether or not the account exists', async () => {
    vi.mocked(authService.requestPasswordReset).mockResolvedValue();
    renderWithAuth(<ForgotPassword />, { auth: signedOut });

    type('Email', 'someone@example.test');
    submit('Send reset link');

    expect(await screen.findByRole('status')).toHaveTextContent('If an account exists for that email');
    expect(authService.requestPasswordReset).toHaveBeenCalledWith({ email: 'someone@example.test' });
  });

  it('validates the email', async () => {
    renderWithAuth(<ForgotPassword />, { auth: signedOut });
    type('Email', 'not-an-email');
    submit('Send reset link');

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(authService.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe('ResetPassword', () => {
  it('explains an expired link when there is no session', () => {
    renderWithAuth(<ResetPassword />, { auth: signedOut });

    expect(screen.getByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('sets the new password for the signed-in recovery session', async () => {
    vi.mocked(authService.updatePassword).mockResolvedValue();
    renderWithAuth(<ResetPassword />, { auth: signedIn() });

    expect(screen.getByText('For maya@example.test')).toBeInTheDocument();
    type('New password', 'brand new pass');
    type('Confirm new password', 'brand new pass');
    submit('Save new password');

    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeInTheDocument();
    expect(authService.updatePassword).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'brand new pass' }),
    );
  });

  it('rejects mismatched passwords', async () => {
    renderWithAuth(<ResetPassword />, { auth: signedIn() });
    type('New password', 'brand new pass');
    type('Confirm new password', 'brand new pas');
    submit('Save new password');

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(authService.updatePassword).not.toHaveBeenCalled();
  });
});
