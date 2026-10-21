import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { forgotPasswordSchema } from '@linka/shared';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { isSupabaseConfigured } from '../lib/supabase';
import { requestPasswordReset } from '../services/auth';
import { fieldErrors } from '../utils/formErrors';

const linkClassName = 'font-medium text-accent underline-offset-4 hover:underline';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).email);
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await requestPasswordReset(parsed.data);
      setSent(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>

      {sent ? (
        <div className="mt-6 grid gap-6">
          {/* Same message whether or not the email has an account. */}
          <Alert tone="success">If an account exists for that email, a reset link is on its way.</Alert>
          <p className="text-sm text-ink-muted">The link opens a page where you can choose a new password.</p>
        </div>
      ) : (
        <>
          <p className="mt-2 text-ink-muted">Enter your email and we will send you a link to choose a new password.</p>
          <form noValidate onSubmit={handleSubmit} className="mt-8 grid gap-5">
            {!isSupabaseConfigured && (
              <Alert tone="danger">Password reset is not configured for this deployment yet.</Alert>
            )}
            {formError && <Alert tone="danger">{formError}</Alert>}
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error}
            />
            <Button type="submit" disabled={submitting || !isSupabaseConfigured}>
              {submitting ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        </>
      )}

      <p className="mt-8 text-sm text-ink-muted">
        Remembered it?{' '}
        <Link to="/login" className={linkClassName}>
          Back to log in
        </Link>
      </p>
    </>
  );
}
