import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { PASSWORD_MIN_LENGTH, resetPasswordSchema } from '@linka/shared';
import { PageLoading } from '../components/layout/PageStatus';
import { Alert } from '../components/ui/Alert';
import { Button, buttonClassName } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../hooks/useAuth';
import { updatePassword } from '../services/auth';
import { fieldErrors } from '../utils/formErrors';

const linkClassName = 'font-medium text-accent underline-offset-4 hover:underline';

/**
 * Opened from the password reset email. supabase-js signs the user in from the link
 * (PASSWORD_RECOVERY), and this page lets them choose a new password.
 */
export function ResetPassword() {
  const { state } = useAuth();
  const [values, setValues] = useState({ password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = resetPasswordSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await updatePassword(parsed.data);
      setDone(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (state.status === 'loading') return <PageLoading label="Checking your reset link" />;

  if (done) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Password updated</h1>
        <p className="mt-2 text-ink-muted">You are signed in with your new password.</p>
        <Link to="/" className={`mt-8 ${buttonClassName}`}>
          Continue to Linka
        </Link>
      </>
    );
  }

  if (state.status !== 'signed_in') {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">This link has expired</h1>
        <p className="mt-2 text-ink-muted">Reset links work once and expire after a while. Request a new one.</p>
        <Link to="/forgot-password" className={`mt-8 ${buttonClassName}`}>
          Request a new link
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-2 text-ink-muted">For {state.session.user.email}</p>

      <form noValidate onSubmit={handleSubmit} className="mt-8 grid gap-5">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          value={values.password}
          onChange={(e) => setValues({ ...values, password: e.target.value })}
          error={errors.password}
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={values.confirmPassword}
          onChange={(e) => setValues({ ...values, confirmPassword: e.target.value })}
          error={errors.confirmPassword}
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save new password'}
        </Button>
      </form>

      <p className="mt-8 text-sm text-ink-muted">
        <Link to="/" className={linkClassName}>
          Cancel
        </Link>
      </p>
    </>
  );
}
