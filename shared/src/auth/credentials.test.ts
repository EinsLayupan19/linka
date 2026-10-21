import { describe, expect, it } from 'vitest';
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema } from './credentials.js';

function firstIssue(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  const issue = result.error?.issues[0];
  return issue ? { path: issue.path.join('.'), message: issue.message } : undefined;
}

describe('registerSchema', () => {
  const valid = { email: 'maya@example.com', password: 'correct horse', confirmPassword: 'correct horse' };

  it('accepts a valid registration and trims the email', () => {
    expect(registerSchema.parse({ ...valid, email: '  maya@example.com ' }).email).toBe('maya@example.com');
  });

  it('rejects an invalid email', () => {
    expect(firstIssue(registerSchema.safeParse({ ...valid, email: 'maya@' }))).toEqual({
      path: 'email',
      message: 'Enter a valid email address.',
    });
  });

  it('asks for an email when it is empty', () => {
    expect(firstIssue(registerSchema.safeParse({ ...valid, email: '   ' }))?.message).toBe('Enter your email address.');
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(firstIssue(registerSchema.safeParse({ ...valid, password: 'short', confirmPassword: 'short' }))).toEqual({
      path: 'password',
      message: 'Use at least 8 characters.',
    });
  });

  it('rejects passwords longer than 72 characters (bcrypt limit)', () => {
    const long = 'a'.repeat(73);
    expect(firstIssue(registerSchema.safeParse({ ...valid, password: long, confirmPassword: long }))?.path).toBe(
      'password',
    );
  });

  it('rejects mismatched passwords on the confirmation field', () => {
    expect(firstIssue(registerSchema.safeParse({ ...valid, confirmPassword: 'different!' }))).toEqual({
      path: 'confirmPassword',
      message: 'Passwords do not match.',
    });
  });
});

describe('loginSchema', () => {
  it('only requires a password to be present', () => {
    expect(loginSchema.safeParse({ email: 'maya@example.com', password: 'x' }).success).toBe(true);
    expect(firstIssue(loginSchema.safeParse({ email: 'maya@example.com', password: '' }))?.message).toBe(
      'Enter your password.',
    );
  });

  it('rejects an invalid email', () => {
    expect(loginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
  });
});

describe('forgotPasswordSchema / resetPasswordSchema', () => {
  it('validates the reset request email', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'maya@example.com' }).success).toBe(true);
    expect(forgotPasswordSchema.safeParse({ email: '' }).success).toBe(false);
  });

  it('applies new-password rules and confirmation to resets', () => {
    expect(resetPasswordSchema.safeParse({ password: 'new password', confirmPassword: 'new password' }).success).toBe(
      true,
    );
    expect(firstIssue(resetPasswordSchema.safeParse({ password: 'new password', confirmPassword: 'other' }))?.path).toBe(
      'confirmPassword',
    );
  });
});
