import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { mockApi } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { CONVERSATION_ID, makeConversation, makeMessage } from '../test/messages';
import { renderWithAuth, testProfile } from '../test/render';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const conversationPath = `/api/conversations/${CONVERSATION_ID}`;
const messagesPath = `${conversationPath}/messages`;

/** A fake API whose profile request waits until `releaseProfile()` is called. */
function slowProfileBackend() {
  let releaseProfile!: () => void;
  const profileReady = new Promise<void>((resolve) => (releaseProfile = resolve));
  const api = mockApi((call) => {
    if (call.path === '/api/users/me') return profileReady.then(() => jsonResponse(testProfile()));
    if (call.method === 'GET' && call.path === '/api/conversations') return jsonResponse({ conversations: [makeConversation()] });
    if (call.method === 'GET' && call.path === conversationPath) return jsonResponse(makeConversation());
    if (call.method === 'GET' && call.path === messagesPath) {
      return jsonResponse({ messages: [makeMessage({ content: 'Hello from Jonas' })], nextCursor: null });
    }
    return undefined;
  });
  return { ...api, releaseProfile };
}

describe('signed-in start-up', () => {
  it('loads the conversation list and the open conversation while the profile is still loading', async () => {
    const api = slowProfileBackend();
    renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });

    await waitFor(() => {
      expect(api.callsTo('GET', '/api/conversations')).toHaveLength(1);
      expect(api.callsTo('GET', messagesPath)).toHaveLength(1);
      expect(api.callsTo('GET', conversationPath)).toHaveLength(1);
    });
    expect(screen.getByRole('status', { name: 'Loading your profile' })).toBeInTheDocument();

    api.releaseProfile();
    expect(await screen.findByText('Hello from Jonas')).toBeInTheDocument();
    // The screens used what was already loaded instead of asking again.
    expect(api.callsTo('GET', '/api/conversations')).toHaveLength(1);
    expect(api.callsTo('GET', messagesPath)).toHaveLength(1);
    expect(api.callsTo('GET', conversationPath)).toHaveLength(1);
  });

  it('prefetches only the list on the chats home page', async () => {
    const api = slowProfileBackend();
    renderWithAuth(<App />, { path: '/' });

    await waitFor(() => expect(api.callsTo('GET', '/api/conversations')).toHaveLength(1));
    api.releaseProfile();
    expect(await screen.findByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path.startsWith(`${conversationPath}`))).toHaveLength(0);
  });

  it('does not prefetch anything for "new chat" routes', async () => {
    const api = slowProfileBackend();
    renderWithAuth(<App />, { path: '/conversations/new' });

    await waitFor(() => expect(api.callsTo('GET', '/api/conversations')).toHaveLength(1));
    expect(api.calls.filter((c) => c.path.startsWith('/api/conversations/'))).toHaveLength(0);
    api.releaseProfile();
  });
});
