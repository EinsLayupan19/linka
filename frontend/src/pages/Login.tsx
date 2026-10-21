import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { loginSchema } from '@linka/shared';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { isSupabaseConfigured } from '../lib/supabase';
import { signIn } from '../services/auth';
import { fieldErrors } from '../utils/formErrors';

const linkClassName = 'font-medium text-accent underline-offset-4 hover:underline';

export function Login() {
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      // On success the auth listener sees the new session and this page redirects.
      await signIn(parsed.data);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
      <p className="mt-2 text-ink-muted">Welcome back to Linka.</p>

      <form noValidate onSubmit={handleSubmit} className="mt-8 grid gap-5">
        {!isSupabaseConfigured && <Alert tone="danger">Sign-in is not configured for this deployment yet.</Alert>}
        {formError && <Alert tone="danger">{formError}</Alert>}

        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(e) => setValues({ ...values, email: e.target.value })}
          error={errors.email}
        />
        <div className="grid gap-2">
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={values.password}
            onChange={(e) => setValues({ ...values, password: e.target.value })}
            error={errors.password}
          />
          <Link to="/forgot-password" className={`justify-self-start text-sm ${linkClassName}`}>
            Forgot password?
          </Link>
        </div>

        <Button type="submit" disabled={submitting || !isSupabaseConfigured}>
          {submitting ? 'Logging in…' : 'Log in'}
        </Button>
      </form>

      <p className="mt-8 text-sm text-ink-muted">
        New to Linka?{' '}
        <Link to="/register" className={linkClassName}>
          Create an account
        </Link>
      </p>
    </>
  );
}
