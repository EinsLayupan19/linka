import { useState } from 'react';
import { signOut } from '../../services/auth';
import { Button } from '../ui/Button';

/**
 * Signs out on this device. The auth listener then switches the app to signed-out,
 * and protected pages redirect to /login.
 */
export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      await signOut();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log out. Try again.');
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-3">
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
      <Button variant="secondary" onClick={handleClick} disabled={pending}>
        {pending ? 'Logging out…' : 'Log out'}
      </Button>
    </span>
  );
}
