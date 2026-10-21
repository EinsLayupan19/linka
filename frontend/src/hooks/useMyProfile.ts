import { useCallback, useEffect, useState } from 'react';
import type { Profile } from '@linka/shared';
import { toApiError, type ApiError } from '../lib/api';
import { getMyProfile } from '../services/profiles';

export type MyProfileState =
  | { status: 'loading' }
  /** Signed in, but the profile has not been set up yet. */
  | { status: 'missing' }
  | { status: 'ready'; profile: Profile }
  | { status: 'error'; error: ApiError };

/** Loads the signed-in user's profile from the API. */
export function useMyProfile() {
  const [state, setState] = useState<MyProfileState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    getMyProfile(controller.signal).then(
      (profile) => setState({ status: 'ready', profile }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError = toApiError(error);
        setState(apiError.code === 'PROFILE_NOT_FOUND' ? { status: 'missing' } : { status: 'error', error: apiError });
      },
    );

    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const setProfile = useCallback((profile: Profile) => setState({ status: 'ready', profile }), []);

  return { state, retry, setProfile };
}
