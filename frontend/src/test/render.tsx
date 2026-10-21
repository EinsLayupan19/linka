import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import type { Profile } from '@linka/shared';
import { AuthContext, type AuthState } from '../hooks/useAuth';
import { fakeSession, TEST_USER_ID } from './supabaseMock';

export const signedIn = (): AuthState => ({ status: 'signed_in', session: fakeSession() });

export function testProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: TEST_USER_ID,
    username: 'maya',
    displayName: 'Maya Reyes',
    avatarPath: null,
    createdAt: '2026-10-21T08:00:00.000Z',
    updatedAt: '2026-10-21T08:00:00.000Z',
    ...overrides,
  };
}

/** Shows the current path so tests can assert redirects. */
function CurrentPath() {
  const location = useLocation();
  // A plain div: <output> would add an implicit role="status" and confuse role queries.
  return <div data-testid="current-path">{location.pathname}</div>;
}

/** Renders `ui` inside a router at `path`, with the given auth state. */
export function renderWithAuth(ui: ReactElement, { path = '/', auth = signedIn() }: { path?: string; auth?: AuthState } = {}) {
  return render(
    <AuthContext.Provider value={{ state: auth }}>
      <MemoryRouter initialEntries={[path]}>
        {ui}
        <CurrentPath />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}
