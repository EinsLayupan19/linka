import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiCall } from '../test/api';
import { readRetry } from '../hooks/useReadTracking';
import { jsonResponse } from '../test/fetch';
import { CONVERSATION_ID, makeConversation, makeMessage } from '../test/messages';
import { conversationReadUpTo, readStateBackend, resetPageVisibility, setPageVisibility } from '../test/readState';
import { renderWithAuth } from '../test/render';
import { App } from '../App';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

/**
 * Saving a read (PUT /read) can fail. Transient failures (no connection, 429, 5xx) are retried a
 * few times; permanent ones are not; "already read further" counts as a confirmed read; and the
 * same read is never sent twice at once.
 */
const OTHER_CONVERSATION = '4c6e8a0c-2e4a-4c6e-9a0c-2e4a6c8e0a2c';
const readPath = `/api/conversations/${CONVERSATION_ID}/read`;
const list = () => screen.getByRole('navigation', { name: 'Conversations' });
const jonasRow = () => within(list()).getAllByRole('link').find((link) => !link.textContent?.includes('Weekend trip'))!;
const leaveConversation = () => fireEvent.click(screen.getByRole('link', { name: 'Back' }));
const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const apiError = (status: number, code: string) => jsonResponse({ error: { code, message: code } }, status);

type ReadAnswer = (call: ApiCall, attempt: number) => Response | Promise<Response> | undefined;

/** My conversation with Jonas: two unread messages, nothing read yet. */
async function openUnreadConversation(onRead: ReadAnswer, extra: Parameters<typeof readStateBackend>[0]['conversations'] = []) {
  const one = makeMessage({ content: 'One' });
  const two = makeMessage({ content: 'Two' });
  const api = readStateBackend(
    { conversations: [conversationReadUpTo(makeConversation(), [one, two], null), ...extra], messages: [one, two] },
    { onRead },
  );
  renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
  await screen.findByRole('log', { name: 'Messages' });
  return { api, newest: two };
}

const productionDelays = [...readRetry.delaysMs];
beforeEach(() => {
  readRetry.delaysMs = [40, 40, 40];
});
afterEach(() => {
  readRetry.delaysMs = productionDelays;
  resetPageVisibility();
});

describe('retrying a read that failed for a passing reason', () => {
  it('waits 2, 5 and 15 seconds between attempts in the app', () => {
    expect(productionDelays).toEqual([2000, 5000, 15000]);
  });

  it.each([
    ['no connection', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['429 Too Many Requests', () => apiError(429, 'RATE_LIMITED')],
    ['503 Service Unavailable', () => apiError(503, 'SERVICE_UNAVAILABLE')],
    ['500 Internal Server Error', () => apiError(500, 'INTERNAL_ERROR')],
  ])('retries after %s, and the saved read clears the badge', async (_label, fail) => {
    const { api } = await openUnreadConversation((_call, attempt) => (attempt === 1 ? fail() : undefined));

    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(2), { timeout: 3000 });
    expect(api.server.conversations[0]!.unreadCount).toBe(0);
    leaveConversation();
    expect(jonasRow()).not.toHaveTextContent('unread');
  });

  it('gives up after three retries, and the badge stays honest', async () => {
    const { api } = await openUnreadConversation(() => apiError(503, 'SERVICE_UNAVAILABLE'));

    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(4), { timeout: 3000 });
    await pause(800);
    expect(api.callsTo('PUT', readPath)).toHaveLength(4);
    leaveConversation();
    expect(jonasRow()).toHaveTextContent('2 unread');
  });

  it('tries again when the tab becomes visible after giving up', async () => {
    const { api } = await openUnreadConversation((_call, attempt) => (attempt <= 4 ? apiError(503, 'SERVICE_UNAVAILABLE') : undefined));
    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(4), { timeout: 3000 });

    setPageVisibility('hidden');
    setPageVisibility('visible');

    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(5), { timeout: 3000 });
    leaveConversation();
    expect(jonasRow()).not.toHaveTextContent('unread');
  });
});

describe('failures that are not retried', () => {
  it.each([
    ['400 Bad Request', () => apiError(400, 'VALIDATION_FAILED')],
    ['404 Not Found', () => apiError(404, 'CONVERSATION_NOT_FOUND')],
  ])('does not retry %s, and the badge stays', async (_label, fail) => {
    const { api } = await openUnreadConversation(() => fail());

    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });
    await pause(800);
    expect(api.callsTo('PUT', readPath)).toHaveLength(1);
    leaveConversation();
    expect(jonasRow()).toHaveTextContent('2 unread');
  });
});

describe('"already read further" (MARKER_BEHIND)', () => {
  it('counts as a confirmed read: the badge clears and nothing is retried', async () => {
    const { api } = await openUnreadConversation(() => apiError(409, 'MARKER_BEHIND'));

    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });
    await pause(800);
    expect(api.callsTo('PUT', readPath)).toHaveLength(1);
    leaveConversation();
    expect(jonasRow()).not.toHaveTextContent('unread');
  });
});

describe('no duplicate read requests', () => {
  it('does not send the same read again while it is still on its way', async () => {
    let answer!: () => void;
    const slow = new Promise<void>((resolve) => (answer = resolve));
    const { api } = await openUnreadConversation((_call, attempt) => (attempt === 1 ? slow.then(() => undefined as never) : undefined));
    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });

    // Switching tabs re-checks whether to send; the first request is still running.
    setPageVisibility('hidden');
    setPageVisibility('visible');
    await pause(900);

    expect(api.callsTo('PUT', readPath)).toHaveLength(1);
    answer();
  });

  it('a read already on its way still clears the badge after leaving the conversation', async () => {
    let answer!: () => void;
    const slow = new Promise<void>((resolve) => (answer = resolve));
    const { api, newest } = await openUnreadConversation((call, attempt) =>
      attempt === 1
        ? slow.then(() => jsonResponse({ conversationId: CONVERSATION_ID, lastReadAt: (call.body as { lastReadAt: string }).lastReadAt, lastDeliveredAt: newest.createdAt }))
        : undefined,
    );
    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });

    leaveConversation();
    expect(jonasRow()).toHaveTextContent('2 unread');
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await waitFor(() => expect(jonasRow()).not.toHaveTextContent('unread'));
  });
});

describe('switching conversations while a read is being retried', () => {
  it('stops retrying once the conversation is left, and keeps its badge', async () => {
    const group = makeConversation({ id: OTHER_CONVERSATION, type: 'group', name: 'Weekend trip' });
    const { api } = await openUnreadConversation(() => apiError(503, 'SERVICE_UNAVAILABLE'), [group]);
    readRetry.delaysMs = [300, 300, 300];
    await waitFor(() => expect(api.callsTo('PUT', readPath)).toHaveLength(1), { timeout: 3000 });

    fireEvent.click(within(list()).getByRole('link', { name: /Weekend trip/ }));
    await pause(1200);

    expect(api.callsTo('PUT', readPath)).toHaveLength(1);
    expect(jonasRow()).toHaveTextContent('2 unread');
  });
});
