import { describe, expect, it } from 'vitest';
import { makeMessage } from '../test/messages';
import {
  conversationMessagesReducer as reduce,
  initialMessagesState,
  type ConversationMessagesState,
} from './conversationMessagesReducer';

const page = (messages = [makeMessage()], nextCursor: string | null = null) => ({ messages, nextCursor });

function ready(messages = [makeMessage(), makeMessage()], nextCursor: string | null = 'older'): ConversationMessagesState {
  return reduce(initialMessagesState, { type: 'loaded', page: page(messages, nextCursor) });
}

describe('loading', () => {
  it('keeps messages that arrived over realtime before the first page', () => {
    const early = makeMessage();
    const stored = makeMessage();
    const withEarly = reduce(initialMessagesState, { type: 'received', messages: [early] });
    const state = reduce(withEarly, { type: 'loaded', page: page([stored]) });
    expect(state.messages.map((m) => m.id)).toEqual([early.id, stored.id]);
  });

  it('adds older pages in order and moves the cursor', () => {
    const [old1, old2] = [makeMessage({ createdAt: '2026-10-01T00:00:00.000Z' }), makeMessage({ createdAt: '2026-10-01T00:00:01.000Z' })];
    const state = reduce(ready(), { type: 'olderLoaded', page: page([old1, old2], 'even-older') });
    expect(state.messages.slice(0, 2)).toEqual([old1, old2]);
    expect(state.nextCursor).toBe('even-older');
  });
});

describe('duplicates', () => {
  it('shows a message once when the API response and the realtime event both carry it', () => {
    const mine = makeMessage({ clientId: 'c1' });
    let state = reduce(ready(), { type: 'sendStarted', pending: { clientId: 'c1', content: 'hi', createdAt: mine.createdAt, status: 'sending' } });
    state = reduce(state, { type: 'received', messages: [mine] }); // realtime echo first
    state = reduce(state, { type: 'received', messages: [mine] }); // then the API response
    expect(state.messages.filter((m) => m.id === mine.id)).toHaveLength(1);
    expect(state.pending).toEqual([]);
  });

  it('ignores a repeated realtime event', () => {
    const message = makeMessage();
    const once = reduce(ready(), { type: 'received', messages: [message] });
    const twice = reduce(once, { type: 'received', messages: [message] });
    expect(twice.messages).toEqual(once.messages);
  });
});

describe('sending', () => {
  it('marks a failed send and lets it be retried', () => {
    let state = reduce(ready(), { type: 'sendStarted', pending: { clientId: 'c1', content: 'hi', createdAt: '', status: 'sending' } });
    state = reduce(state, { type: 'sendFailed', clientId: 'c1', error: 'Could not reach the server.' });
    expect(state.pending[0]).toMatchObject({ status: 'failed', error: 'Could not reach the server.' });

    state = reduce(state, { type: 'sendRetried', clientId: 'c1' });
    expect(state.pending[0]).toEqual({ clientId: 'c1', content: 'hi', createdAt: '', status: 'sending' });
  });
});

describe('after reconnecting', () => {
  it('merges the newest page when it overlaps what is shown', () => {
    const [a, b] = [makeMessage(), makeMessage()];
    const missed = makeMessage();
    const state = reduce(ready([a, b], 'older'), { type: 'latestRefetched', page: page([b, missed], 'cursor-b') });
    expect(state.messages.map((m) => m.id)).toEqual([a.id, b.id, missed.id]);
    expect(state.nextCursor).toBe('older'); // older pagination continues from what was loaded
  });

  it('starts over from the newest page when too much was missed to connect', () => {
    const [a, b] = [makeMessage(), makeMessage()];
    const newest = [makeMessage(), makeMessage()];
    const state = reduce(ready([a, b], 'older'), { type: 'latestRefetched', page: page(newest, 'cursor-new') });
    expect(state.messages).toEqual(newest);
    expect(state.nextCursor).toBe('cursor-new');
  });

  it('clears pending messages that turn out to have been sent', () => {
    const sent = makeMessage({ clientId: 'c1' });
    let state = reduce(ready(), { type: 'sendStarted', pending: { clientId: 'c1', content: 'x', createdAt: '', status: 'failed' } });
    state = reduce(state, { type: 'latestRefetched', page: page([sent]) });
    expect(state.pending).toEqual([]);
  });
});
