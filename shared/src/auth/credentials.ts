import { z } from 'zod';

// Supabase Auth hashes passwords with bcrypt, which only uses the first 72 bytes.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .pipe(z.email('Enter a valid email address.'));

/** Rules for choosing a new password (registration and reset). */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

const passwordsMatch = (value: { password: string; confirmPassword: string }) =>
  value.password === value.confirmPassword;
const passwordsMismatch = { path: ['confirmPassword'], message: 'Passwords do not match.' };

export const loginSchema = z.object({
  email: emailSchema,
  // Login only checks presence: older passwords may predate the current rules.
  password: z.string().min(1, 'Enter your password.'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, passwordsMismatch);

export type RegisterInput = z.infer<typeof registerSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, passwordsMismatch);

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
