import { act, render, screen } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../hooks/useAuth';
import { attachmentUrl, clearAttachmentUrls } from '../../services/attachmentUrls';
import { mockApi } from '../../test/api';
import { jsonResponse } from '../../test/fetch';
import { authMock, fakeSession, supabaseState } from '../../test/supabaseMock';
import { AuthProvider } from './AuthProvider';

vi.mock('../../lib/supabase', async () => (await import('../../test/supabaseMock')).supabaseModule);

function ShowAuth() {
  const { state } = useAuth();
  return (
    <p>
      <span data-testid="status">{state.status}</span>
      <span data-testid="token">{state.status === 'signed_in' ? state.session.access_token : ''}</span>
    </p>
  );
}

type Listener = (event: string, session: Session | null) => void;

/** Captures the listener AuthProvider registers so tests can emit Supabase auth events. */
function captureListener() {
  const unsubscribe = vi.fn();
  let listener: Listener | undefined;
  authMock.onAuthStateChange.mockImplementation((callback: Listener) => {
    listener = callback;
    return { data: { subscription: { unsubscribe } } };
  });
  return {
    unsubscribe,
    emit: (event: string, session: Session | null) => act(() => listener?.(event, session)),
  };
}

beforeEach(() => {
  supabaseState.configured = true;
  clearAttachmentUrls();
});

describe('AuthProvider', () => {
  it('starts loading, then reflects the restored session', () => {
    const auth = captureListener();
    render(
      <AuthProvider>
        <ShowAuth />
      </AuthProvider>,
    );
    expect(screen.getByTestId('status')).toHaveTextContent('loading');

    auth.emit('INITIAL_SESSION', fakeSession());
    expect(screen.getByTestId('status')).toHaveTextContent('signed_in');
  });

  it('is signed out when no session is stored', () => {
    const auth = captureListener();
    render(
      <AuthProvider>
        <ShowAuth />
      </AuthProvider>,
    );

    auth.emit('INITIAL_SESSION', null);
    expect(screen.getByTestId('status')).toHaveTextContent('signed_out');
  });

  it('follows sign in, token refresh and sign out', () => {
    const auth = captureListener();
    render(
      <AuthProvider>
        <ShowAuth />
      </AuthProvider>,
    );

    auth.emit('INITIAL_SESSION', null);
    auth.emit('SIGNED_IN', fakeSession({ accessToken: 'first-token' }));
    expect(screen.getByTestId('token')).toHaveTextContent('first-token');

    auth.emit('TOKEN_REFRESHED', fakeSession({ accessToken: 'refreshed-token' }));
    expect(screen.getByTestId('status')).toHaveTextContent('signed_in');
    expect(screen.getByTestId('token')).toHaveTextContent('refreshed-token');

    auth.emit('SIGNED_OUT', null);
    expect(screen.getByTestId('status')).toHaveTextContent('signed_out');
  });

  it('forgets cached attachment URLs on sign-out, so the next user never reuses them', async () => {
    const id = '3f9a1c2e-4b6d-4e8f-9a1b-2c3d4e5f6a7b';
    const api = mockApi(() =>
      jsonResponse({ urls: [{ id, url: 'https://storage.test/sign/x', expiresAt: new Date(Date.now() + 600_000).toISOString() }] }),
    );
    const auth = captureListener();
    render(
      <AuthProvider>
        <ShowAuth />
      </AuthProvider>,
    );
    auth.emit('SIGNED_IN', fakeSession());
    await attachmentUrl(id);
    await attachmentUrl(id);
    expect(api.calls).toHaveLength(1);

    auth.emit('SIGNED_OUT', null);
    await attachmentUrl(id);
    expect(api.calls).toHaveLength(2);
  });

  it('treats a password-recovery link as a signed-in session', () => {
    const auth = captureListener();
    render(
      <AuthProvider>
        <ShowAuth />
      </AuthProvider>,
    );

    auth.emit('PASSWORD_RECOVERY', fakeSession());
    expect(screen.getByTestId('status')).toHaveTextContent('signed_in');
  });

  it('unsubscribes from Supabase when unmounted', () => {
    const auth = captureListener();
    const { unmount } = render(
      <AuthProvider>
        <ShowAuth />
      </AuthProvider>,
    );

    unmount();
    expect(auth.unsubscribe).toHaveBeenCalledOnce();
  });

  it('reports "unconfigured" and never touches Supabase without credentials', () => {
    supabaseState.configured = false;
    render(
      <AuthProvider>
        <ShowAuth />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status')).toHaveTextContent('unconfigured');
    expect(authMock.onAuthStateChange).not.toHaveBeenCalled();
  });
});
