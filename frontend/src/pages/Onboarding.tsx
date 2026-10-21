import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { createProfileSchema, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '@linka/shared';
import { SignOutButton } from '../components/auth/SignOutButton';
import { PageLoading, PageMessage } from '../components/layout/PageStatus';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { useMyProfile } from '../hooks/useMyProfile';
import { ApiError } from '../lib/api';
import { createMyProfile } from '../services/profiles';
import { fieldErrors } from '../utils/formErrors';

/** First step after signing up: choose a username and display name. */
export function Onboarding() {
  const { state, retry } = useMyProfile();
  const navigate = useNavigate();
  const [values, setValues] = useState({ username: '', displayName: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = createProfileSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await createMyProfile(parsed.data);
      navigate('/profile', { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PROFILE_EXISTS') {
        navigate('/profile', { replace: true });
        return;
      }
      if (error instanceof ApiError && error.fields) setErrors(error.fields);
      else setFormError(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  if (state.status === 'loading') return <PageLoading label="Loading your profile" />;
  if (state.status === 'ready') return <Navigate to="/profile" replace />;
  if (state.status === 'error') {
    return (
      <PageMessage
        title="Could not load your profile"
        actions={
          <>
            <Button onClick={retry}>Try again</Button>
            <SignOutButton />
          </>
        }
      >
        {state.error.message}
      </PageMessage>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Set up your profile</h1>
      <p className="mt-2 text-ink-muted">This is how people will find and recognise you.</p>

      <form noValidate onSubmit={handleSubmit} className="mt-8 grid gap-5">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <TextField
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          hint={`${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters: letters, numbers and underscores.`}
          value={values.username}
          onChange={(e) => setValues({ ...values, username: e.target.value })}
          error={errors.username}
        />
        <TextField
          label="Display name"
          autoComplete="name"
          value={values.displayName}
          onChange={(e) => setValues({ ...values, displayName: e.target.value })}
          error={errors.displayName}
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Continue'}
        </Button>
      </form>

      <div className="mt-8">
        <SignOutButton />
      </div>
    </>
  );
}
