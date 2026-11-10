import { useEffect, useMemo, useState } from 'react';
import { Link, matchPath, Navigate, Outlet, useLocation } from 'react-router';
import { ProfileContext } from '../../hooks/useProfile';
import { useAuth } from '../../hooks/useAuth';
import { useMyProfile } from '../../hooks/useMyProfile';
import { prefetch, prefetchKeys } from '../../lib/prefetch';
import { getConversation, listConversations } from '../../services/conversations';
import { listMessages } from '../../services/messages';
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
 * Starts what the chat screens will need (the conversation list and, when the app opens on one,
 * that conversation) while the profile is still loading, instead of after it. The screens pick
 * these results up on their first load (see lib/prefetch.ts). Runs once per signed-in user.
 */
function usePrefetchChats() {
  const { state } = useAuth();
  const userId = state.status === 'signed_in' ? state.session.user.id : null;
  // Where the app opened (later navigation loads on demand as before).
  const { pathname } = useLocation();
  const [path] = useState(pathname);

  useEffect(() => {
    if (!userId) return;
    prefetch(prefetchKeys.conversations(userId), () => listConversations());
    const conversationId = matchPath('/conversations/:conversationId', path)?.params.conversationId;
    if (conversationId && conversationId !== 'new') {
      prefetch(prefetchKeys.conversation(userId, conversationId), () => getConversation(conversationId));
      prefetch(prefetchKeys.messages(userId, conversationId), () => listMessages(conversationId));
    }
  }, [userId, path]);
}

/**
 * Loads the signed-in user's profile and shares it with the pages below.
 * Users without a profile are sent to /onboarding to set one up.
 */
export function RequireProfile() {
  // The profile request goes first (it gates the page); the chat prefetch right after it.
  const { state, retry, setProfile } = useMyProfile();
  usePrefetchChats();
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
