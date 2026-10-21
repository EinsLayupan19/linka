import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { jsonResponse, mockFetch } from './test/fetch';
import { renderWithAuth, signedIn, testProfile } from './test/render';

vi.mock('./lib/supabase', async () => (await import('./test/supabaseMock')).supabaseModule);

const currentPath = () => screen.getByTestId('current-path').textContent;

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

  it('takes signed-in users with a profile from / to their profile', async () => {
    mockFetch().mockResolvedValue(jsonResponse(testProfile()));
    renderWithAuth(<App />, { path: '/' });

    expect(await screen.findByRole('heading', { name: 'Maya Reyes' })).toBeInTheDocument();
    expect(currentPath()).toBe('/profile');
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Maya Reyes' })).toBeInTheDocument();
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
    mockFetch().mockResolvedValue(jsonResponse(testProfile()));
    renderWithAuth(<App />, { path: '/login', auth: signedIn() });

    expect(await screen.findByRole('heading', { name: 'Maya Reyes' })).toBeInTheDocument();
    expect(currentPath()).toBe('/profile');
  });

  it.each([
    ['/register', 'Create your account'],
    ['/forgot-password', 'Reset your password'],
  ])('renders %s for signed-out users', (path, heading) => {
    renderWithAuth(<App />, { path, auth: { status: 'signed_out' } });
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });
});

describe('public pages', () => {
  it('shows the status page without signing in', () => {
    mockFetch().mockReturnValue(new Promise(() => {}));
    renderWithAuth(<App />, { path: '/status', auth: { status: 'signed_out' } });

    expect(screen.getByRole('heading', { name: 'System status' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', () => {
    renderWithAuth(<App />, { path: '/nowhere', auth: { status: 'signed_out' } });

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });
});
