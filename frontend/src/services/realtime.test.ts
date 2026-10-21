import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { conversationTopic } from '@linka/shared';
import { CONVERSATION_ID, makeMessage } from '../test/messages';
import { latestChannel, realtimeMock } from '../test/supabaseMock';
import { subscribeToConversation } from './realtime';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

function subscribe() {
  const handlers = { onMessage: vi.fn(), onStatus: vi.fn(), onJoined: vi.fn() };
  const unsubscribe = subscribeToConversation(CONVERSATION_ID, handlers);
  return { handlers, unsubscribe };
}

/** Waits until the channel has subscribed (setAuth resolves first). */
async function joinedChannel() {
  const channel = latestChannel(conversationTopic(CONVERSATION_ID));
  await waitFor(() => expect(realtimeMock.setAuth).toHaveBeenCalled());
  await Promise.resolve();
  return channel;
}

describe('subscribeToConversation', () => {
  it('joins only this conversation’s private channel, after setting the access token', async () => {
    subscribe();
    const channel = await joinedChannel();

    expect(channel.topic).toBe(`conversation:${CONVERSATION_ID}`);
    expect(channel.options).toEqual({ config: { private: true } });
    expect(realtimeMock.channel).toHaveBeenCalledOnce();
  });

  it('reports connecting, then live, and asks for a refetch on every join', async () => {
    const { handlers } = subscribe();
    const channel = await joinedChannel();
    expect(handlers.onStatus).toHaveBeenCalledWith('connecting');

    channel.join();
    expect(handlers.onStatus).toHaveBeenLastCalledWith('live');
    expect(handlers.onJoined).toHaveBeenCalledTimes(1);

    channel.fail('CHANNEL_ERROR');
    expect(handlers.onStatus).toHaveBeenLastCalledWith('reconnecting');

    channel.join(); // supabase-js rejoined by itself
    expect(handlers.onStatus).toHaveBeenLastCalledWith('live');
    expect(handlers.onJoined).toHaveBeenCalledTimes(2);
  });

  it.each(['TIMED_OUT', 'CLOSED'] as const)('treats %s as reconnecting', async (status) => {
    const { handlers } = subscribe();
    const channel = await joinedChannel();
    channel.join();
    channel.fail(status);
    expect(handlers.onStatus).toHaveBeenLastCalledWith('reconnecting');
  });

  it('delivers well-formed message.created events for this conversation', async () => {
    const { handlers } = subscribe();
    const channel = await joinedChannel();
    const message = makeMessage();

    channel.emit('message.created', message);
    expect(handlers.onMessage).toHaveBeenCalledWith(message);
  });

  it('ignores malformed payloads, other conversations and other events', async () => {
    const { handlers } = subscribe();
    const channel = await joinedChannel();

    channel.emit('message.created', { id: 'not-a-message' });
    channel.emit('message.created', makeMessage({ conversationId: '1b3d5f7a-9c1e-4a3b-8d5f-7a9c1e3b5d7f' }));
    channel.emit('something.else', makeMessage());
    expect(handlers.onMessage).not.toHaveBeenCalled();
  });

  it('leaves the channel and goes quiet after unsubscribing', async () => {
    const { handlers, unsubscribe } = subscribe();
    const channel = await joinedChannel();
    channel.join();
    handlers.onStatus.mockClear();

    unsubscribe();
    expect(channel.removed).toBe(true);

    channel.emit('message.created', makeMessage());
    channel.fail('CLOSED');
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(handlers.onStatus).not.toHaveBeenCalled();
  });

  it('never subscribes if it was left before the token was set', async () => {
    const { handlers, unsubscribe } = subscribe();
    unsubscribe();
    await waitFor(() => expect(realtimeMock.setAuth).toHaveBeenCalled());
    await Promise.resolve();

    const channel = latestChannel();
    expect(channel.removed).toBe(true);
    channel.join(); // no status callback was ever registered
    expect(handlers.onStatus).toHaveBeenCalledTimes(1); // only the initial "connecting"
    expect(handlers.onJoined).not.toHaveBeenCalled();
  });
});
