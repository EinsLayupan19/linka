import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { PASSWORD_MIN_LENGTH, registerSchema } from '@linka/shared';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { isSupabaseConfigured } from '../lib/supabase';
import { signUp } from '../services/auth';
import { fieldErrors } from '../utils/formErrors';

const linkClassName = 'font-medium text-accent underline-offset-4 hover:underline';

export function Register() {
  const [values, setValues] = useState({ email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = registerSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await signUp(parsed.data);
      // Without email confirmation the user is signed in now and this page redirects.
      if (needsEmailConfirmation) setSentTo(parsed.data.email);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-ink-muted">
          We sent a confirmation link to <span className="font-medium text-ink">{sentTo}</span>. Open it to finish
          creating your account.
        </p>
        <p className="mt-8 text-sm text-ink-muted">
          Already confirmed?{' '}
          <Link to="/login" className={linkClassName}>
            Log in
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-2 text-ink-muted">You will choose a username next.</p>

      <form noValidate onSubmit={handleSubmit} className="mt-8 grid gap-5">
        {!isSupabaseConfigured && <Alert tone="danger">Sign-up is not configured for this deployment yet.</Alert>}
        {formError && <Alert tone="danger">{formError}</Alert>}

        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(e) => setValues({ ...values, email: e.target.value })}
          error={errors.email}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          value={values.password}
          onChange={(e) => setValues({ ...values, password: e.target.value })}
          error={errors.password}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={values.confirmPassword}
          onChange={(e) => setValues({ ...values, confirmPassword: e.target.value })}
          error={errors.confirmPassword}
        />

        <Button type="submit" disabled={submitting || !isSupabaseConfigured}>
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <p className="mt-8 text-sm text-ink-muted">
        Already have an account?{' '}
        <Link to="/login" className={linkClassName}>
          Log in
        </Link>
      </p>
    </>
  );
}
