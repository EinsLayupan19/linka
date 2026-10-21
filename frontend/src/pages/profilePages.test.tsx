import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RequireProfile } from '../components/auth/RouteGuards';
import { jsonResponse, mockFetch } from '../test/fetch';
import { renderWithAuth, testProfile } from '../test/render';
import { Onboarding } from './Onboarding';
import { Profile } from './Profile';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const notFound = () => jsonResponse({ error: { code: 'PROFILE_NOT_FOUND', message: 'Not set up yet' } }, 404);

function renderOnboarding() {
  return renderWithAuth(
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/profile" element={<h1>Profile page</h1>} />
    </Routes>,
    { path: '/onboarding' },
  );
}

function renderProfile() {
  return renderWithAuth(
    <Routes>
      <Route element={<RequireProfile />}>
        <Route path="/profile" element={<Profile />} />
      </Route>
    </Routes>,
    { path: '/profile' },
  );
}

describe('Onboarding', () => {
  it('creates the profile with the signed-in user’s token, then opens the profile', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(jsonResponse(testProfile(), 201));
    renderOnboarding();

    await screen.findByLabelText('Username');
    type('Username', 'Maya');
    type('Display name', 'Maya Reyes');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Profile page' })).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-access-token');
    expect(JSON.parse(String(init?.body))).toEqual({ username: 'maya', displayName: 'Maya Reyes' });
  });

  it('validates the username before calling the API', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(notFound());
    renderOnboarding();

    await screen.findByLabelText('Username');
    type('Username', 'no spaces');
    type('Display name', 'Maya');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Use only letters, numbers and underscores.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a taken username on the username field', async () => {
    mockFetch()
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'USERNAME_TAKEN', message: 'That username is taken.', fields: { username: 'That username is taken.' } } },
          409,
        ),
      );
    renderOnboarding();

    await screen.findByLabelText('Username');
    type('Username', 'maya');
    type('Display name', 'Maya');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('That username is taken.')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
  });

  it('skips onboarding when the profile already exists', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse(testProfile()));
    renderOnboarding();

    expect(await screen.findByRole('heading', { name: 'Profile page' })).toBeInTheDocument();
  });
});

describe('Profile', () => {
  it('shows the profile and the signed-in email', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse(testProfile()));
    renderProfile();

    expect(await screen.findByRole('heading', { name: 'Maya Reyes' })).toBeInTheDocument();
    expect(screen.getByText('@maya')).toBeInTheDocument();
    expect(screen.getByText('maya@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves a new display name', async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(testProfile()))
      .mockResolvedValueOnce(jsonResponse(testProfile({ displayName: 'Maya R.' })));
    renderProfile();

    await screen.findByLabelText('Display name');
    type('Display name', 'Maya R.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Profile saved.');
    expect(screen.getByRole('heading', { name: 'Maya R.' })).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: 'Maya R.' });
  });

  it('rejects an empty display name', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(testProfile()));
    renderProfile();

    await screen.findByLabelText('Display name');
    type('Display name', '   ');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Enter a display name.')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('shows a save error', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse(testProfile()))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderProfile();

    await screen.findByLabelText('Display name');
    type('Display name', 'Maya R.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the server/);
  });
});
