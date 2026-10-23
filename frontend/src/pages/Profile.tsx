import { useState, type FormEvent } from 'react';
import { updateProfileSchema } from '@linka/shared';
import { AvatarEditor } from '../components/profile/AvatarEditor';
import { ThemeSelect } from '../components/theme/ThemeSelect';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../hooks/useAuth';
import { useProfile } from '../hooks/useProfile';
import { ApiError } from '../lib/api';
import { updateMyProfile } from '../services/profiles';
import { fieldErrors } from '../utils/formErrors';

const memberSince = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

export function Profile() {
  const { profile, setProfile } = useProfile();
  const { state } = useAuth();
  const email = state.status === 'signed_in' ? state.session.user.email : undefined;

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const unchanged = displayName.trim() === profile.displayName;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSaved(false);

    const parsed = updateProfileSchema.safeParse({ displayName });
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).displayName);
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      const updated = await updateMyProfile(parsed.data);
      setProfile(updated);
      setDisplayName(updated.displayName);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.fields?.displayName) setError(e.fields.displayName);
      else setFormError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{profile.displayName}</h1>
        <p className="truncate text-ink-muted">@{profile.username}</p>
      </div>

      <section aria-label="Profile picture" className="mt-6">
        <AvatarEditor profile={profile} onChange={setProfile} />
      </section>

      <dl className="mt-8 grid gap-4 border-t border-line pt-6 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-muted">Email</dt>
          <dd className="mt-1 break-all">{email ?? 'Not available'}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Member since</dt>
          <dd className="mt-1">{memberSince.format(new Date(profile.createdAt))}</dd>
        </div>
      </dl>

      <section aria-labelledby="appearance-heading" className="mt-8 border-t border-line pt-6">
        <h2 id="appearance-heading" className="mb-4 text-lg font-semibold tracking-tight">
          Appearance
        </h2>
        <ThemeSelect />
      </section>

      <form noValidate onSubmit={handleSubmit} className="mt-10 grid max-w-sm gap-5">
        <h2 className="text-lg font-semibold tracking-tight">Edit profile</h2>
        {formError && <Alert tone="danger">{formError}</Alert>}
        {saved && <Alert tone="success">Profile saved.</Alert>}
        <TextField
          label="Display name"
          autoComplete="name"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
          error={error}
        />
        <div>
          <Button type="submit" disabled={submitting || unchanged}>
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </div>
  );
}
