import { useRef, useState } from 'react';
import { AVATAR_CONTENT_TYPES, type Profile } from '@linka/shared';
import { toApiError } from '../../lib/api';
import { removeMyAvatar, uploadMyAvatar } from '../../services/profiles';
import { avatarProblem } from '../../utils/attachments';
import { Alert } from '../ui/Alert';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';

/** The profile picture with Change / Remove. */
export function AvatarEditor({ profile, onChange }: { profile: Profile; onChange: (profile: Profile) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'uploading' | 'removing', request: () => Promise<Profile>) {
    setBusy(action);
    setError(null);
    try {
      onChange(await request());
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setBusy(null);
    }
  }

  function pick(file: File | undefined) {
    if (!file) return;
    const problem = avatarProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    void run('uploading', () => uploadMyAvatar(file, file.type));
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-4">
        <Avatar name={profile.displayName} src={profile.avatarUrl} size="lg" />
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={AVATAR_CONTENT_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button variant="secondary" disabled={busy !== null} onClick={() => fileRef.current?.click()} className="h-9 px-3">
            {busy === 'uploading' ? 'Uploading…' : profile.avatarUrl ? 'Change photo' : 'Add photo'}
          </Button>
          {profile.avatarUrl && (
            <Button variant="secondary" disabled={busy !== null} onClick={() => void run('removing', removeMyAvatar)} className="h-9 px-3">
              {busy === 'removing' ? 'Removing…' : 'Remove photo'}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-ink-muted">JPEG, PNG or WebP, up to 2 MB.</p>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
