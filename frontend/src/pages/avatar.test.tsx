import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { MAX_AVATAR_BYTES } from '@linka/shared';
import { RequireProfile } from '../components/auth/RouteGuards';
import { Avatar } from '../components/ui/Avatar';
import { mockApi } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { renderWithAuth, testProfile } from '../test/render';
import { testFile } from '../test/xhr';
import { Profile } from './Profile';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const SIGNED = 'https://storage.test/sign/avatars/me.png?token=a';

function renderProfile(answer: (method: string) => Response | undefined = () => undefined, initial = testProfile()) {
  const api = mockApi((call) => {
    if (call.path === '/api/users/me' && call.method === 'GET') return jsonResponse(initial);
    if (call.path === '/api/users/me/avatar') return answer(call.method);
    return undefined;
  });
  renderWithAuth(
    <Routes>
      <Route element={<RequireProfile />}>
        <Route path="/profile" element={<Profile />} />
      </Route>
    </Routes>,
    { path: '/profile' },
  );
  return api;
}

const pick = (file: File) => fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });

describe('profile picture', () => {
  it('uploads the picked image as the request body and shows the new picture', async () => {
    const api = renderProfile((method) => (method === 'PUT' ? jsonResponse(testProfile({ avatarUrl: SIGNED })) : undefined));
    fireEvent.click(await screen.findByRole('button', { name: 'Add photo' }));
    const file = testFile('me.png', 'image/png');

    pick(file);

    expect(await screen.findByRole('button', { name: 'Change photo' })).toBeInTheDocument();
    const [put] = api.callsTo('PUT', '/api/users/me/avatar');
    expect(put!.body).toBe(file);
    expect(put!.contentType).toBe('image/png');
    expect(put!.authorization).toMatch(/^Bearer /);
    expect(document.querySelector('img')).toHaveAttribute('src', SIGNED);
  });

  it.each([
    ['an unsupported type', testFile('me.gif', 'image/gif'), 'Use a JPEG, PNG or WebP image.'],
    ['an SVG', testFile('me.svg', 'image/svg+xml'), 'Use a JPEG, PNG or WebP image.'],
    ['a picture over 2 MB', testFile('me.jpg', 'image/jpeg', MAX_AVATAR_BYTES + 1), 'Profile pictures can be at most 2 MB.'],
  ])('refuses %s without uploading', async (_label, file, message) => {
    const api = renderProfile();
    await screen.findByRole('button', { name: 'Add photo' });
    pick(file);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(api.callsTo('PUT', '/api/users/me/avatar')).toEqual([]);
  });

  it('shows the server’s reason when it rejects the image', async () => {
    renderProfile(() => jsonResponse({ error: { code: 'UPLOAD_REJECTED', message: 'The file content does not match its type.' } }, 422));
    await screen.findByRole('button', { name: 'Add photo' });
    pick(testFile('me.png', 'image/png'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The file content does not match its type.');
    expect(screen.getByRole('button', { name: 'Add photo' })).toBeEnabled();
  });

  it('removes the picture', async () => {
    const api = renderProfile((method) => (method === 'DELETE' ? jsonResponse(testProfile()) : undefined), testProfile({ avatarUrl: SIGNED }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove photo' }));
    expect(await screen.findByRole('button', { name: 'Add photo' })).toBeInTheDocument();
    expect(api.callsTo('DELETE', '/api/users/me/avatar')).toHaveLength(1);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Avatar', () => {
  it('shows the picture, and the initial when there is none or it fails to load', async () => {
    const { container, rerender } = render(<Avatar name="Maya" src={SIGNED} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('alt', '');

    fireEvent.error(img);
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
    expect(container).toHaveTextContent('M');

    // A new URL (e.g. refreshed after expiry) is tried again.
    rerender(<Avatar name="Maya" src={`${SIGNED}&v=2`} />);
    expect(container.querySelector('img')).not.toBeNull();

    rerender(<Avatar name="Maya" src={null} />);
    expect(container.querySelector('img')).toBeNull();
  });
});
