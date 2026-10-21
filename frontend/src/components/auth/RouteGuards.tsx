import { useMemo } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { ProfileContext } from '../../hooks/useProfile';
import { useAuth } from '../../hooks/useAuth';
import { useMyProfile } from '../../hooks/useMyProfile';
import { safeRedirectPath, type RedirectState } from '../../utils/redirect';
import { PageLoading, PageMessage } from '../layout/PageStatus';
import { Button, secondaryButtonClassName } from '../ui/Button';
import { SignOutButton } from './SignOutButton';

function AuthUnavailable() {
  return (
    <PageMessage
      title="Sign-in is unavailable"
      actions={
        <Link to="/status" className={secondaryButtonClassName}>
          View system status
        </Link>
      }
    >
      Authentication is not configured for this deployment yet.
    </PageMessage>
  );
}

/** Only signed-in users get through; everyone else goes to /login. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') return <PageLoading label="Checking your session" />;
  if (state.status === 'unconfigured') return <AuthUnavailable />;
  if (state.status === 'signed_out') {
    const redirect: RedirectState = { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={redirect} />;
  }
  return <Outlet />;
}

/** Login/register pages: signed-in users are sent on to where they were going. */
export function RedirectIfSignedIn() {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') return <PageLoading label="Checking your session" />;
  if (state.status === 'signed_in') {
    return <Navigate to={safeRedirectPath((location.state as RedirectState | null)?.from)} replace />;
  }
  return <Outlet />;
}

/**
 * Loads the signed-in user's profile and shares it with the pages below.
 * Users without a profile are sent to /onboarding to set one up.
 */
export function RequireProfile() {
  const { state, retry, setProfile } = useMyProfile();
  const profile = state.status === 'ready' ? state.profile : null;
  const value = useMemo(() => (profile ? { profile, setProfile } : null), [profile, setProfile]);

  if (state.status === 'loading') return <PageLoading label="Loading your profile" />;
  if (state.status === 'missing') return <Navigate to="/onboarding" replace />;
  if (state.status === 'error' || !value) {
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
        {state.status === 'error' ? state.error.message : 'Something went wrong. Please try again.'}
      </PageMessage>
    );
  }

  return (
    <ProfileContext.Provider value={value}>
      <Outlet />
    </ProfileContext.Provider>
  );
}
