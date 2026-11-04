import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockApi } from './test/api';
import { jsonResponse, mockFetch } from './test/fetch';
import { renderWithAuth, signedIn, testProfile } from './test/render';

vi.mock('./lib/supabase', async () => (await import('./test/supabaseMock')).supabaseModule);

const currentPath = () => screen.getByTestId('current-path').textContent;

/** A signed-in user with a profile and no conversations yet. */
function signedInBackend() {
  mockApi((call) => {
    if (call.path === '/api/users/me') return jsonResponse(testProfile());
    if (call.path === '/api/conversations') return jsonResponse({ conversations: [] });
    return undefined;
  });
}

describe('protected routes', () => {
  it('sends signed-out users to the login page', async () => {
    renderWithAuth(<App />, { path: '/profile', auth: { status: 'signed_out' } });

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(currentPath()).toBe('/login');
  });

  it('waits while the session is being restored', () => {
    renderWithAuth(<App />, { path: '/profile', auth: { status: 'loading' } });

    expect(screen.getByRole('status', { name: 'Checking your session' })).toBeInTheDocument();
    expect(currentPath()).toBe('/profile');
  });

  it('explains when authentication is not configured', () => {
    renderWithAuth(<App />, { path: '/profile', auth: { status: 'unconfigured' } });

    expect(screen.getByRole('heading', { name: 'Sign-in is unavailable' })).toBeInTheDocument();
  });

  it('shows signed-in users with a profile their chats at /', async () => {
    signedInBackend();
    renderWithAuth(<App />, { path: '/' });

    expect(await screen.findByRole('heading', { name: 'Chats' })).toBeInTheDocument();
    expect(currentPath()).toBe('/');
    const header = within(screen.getByRole('banner'));
    expect(header.getByRole('link', { name: 'Maya Reyes' })).toHaveAttribute('href', '/profile');
    expect(header.getByRole('link', { name: 'Chats' })).toHaveAttribute('href', '/');
  });

  it('sends signed-in users without a profile to onboarding', async () => {
    // Fresh Response per call: the guard and the onboarding page each fetch the profile.
    mockFetch().mockImplementation(async () =>
      jsonResponse({ error: { code: 'PROFILE_NOT_FOUND', message: 'Not set up yet' } }, 404),
    );
    renderWithAuth(<App />, { path: '/profile' });

    expect(await screen.findByRole('heading', { name: 'Set up your profile' })).toBeInTheDocument();
    expect(currentPath()).toBe('/onboarding');
  });

  it('shows an error with retry when the profile cannot load', async () => {
    mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    renderWithAuth(<App />, { path: '/profile' });

    expect(await screen.findByRole('heading', { name: 'Could not load your profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });
});

describe('signed-out pages', () => {
  it('redirects signed-in users away from the login page', async () => {
    signedInBackend();
    renderWithAuth(<App />, { path: '/login', auth: signedIn() });

    expect(await screen.findByRole('heading', { name: 'Chats' })).toBeInTheDocument();
    expect(currentPath()).toBe('/');
  });

  it.each([
    ['/register', 'Create your account'],
    ['/forgot-password', 'Reset your password'],
  ])('renders %s for signed-out users', async (path, heading) => {
    renderWithAuth(<App />, { path, auth: { status: 'signed_out' } });
    // Pages other than the chats load on first use (code splitting), so wait for them.
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });
});

describe('page names and keyboard access', () => {
  it('names each page in the tab title and announces the new page after moving between pages', async () => {
    renderWithAuth(<App />, { path: '/login', auth: { status: 'signed_out' } });
    await screen.findByRole('heading', { name: 'Log in' });
    await waitFor(() => expect(document.title).toBe('Log in · Linka'));

    fireEvent.click(screen.getByRole('link', { name: /create an account/i }));
    await screen.findByRole('heading', { name: 'Create your account' });
    await waitFor(() => expect(document.title).toBe('Create your account · Linka'));
    await waitFor(() => expect(screen.getByTestId('page-announcer')).toHaveTextContent('Create your account'));
    expect(screen.getByTestId('page-announcer')).toHaveAttribute('aria-live', 'polite');
  });

  it('offers a skip link that leads past the header to the page', async () => {
    renderWithAuth(<App />, { path: '/nowhere', auth: { status: 'signed_out' } });
    await screen.findByRole('heading', { name: 'Page not found' });
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });
});

describe('public pages', () => {
  it('shows the status page without signing in', async () => {
    mockFetch().mockReturnValue(new Promise(() => {}));
    renderWithAuth(<App />, { path: '/status', auth: { status: 'signed_out' } });

    expect(await screen.findByRole('heading', { name: 'System status' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', async () => {
    renderWithAuth(<App />, { path: '/nowhere', auth: { status: 'signed_out' } });

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });
});
