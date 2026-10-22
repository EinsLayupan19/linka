import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveTopic } from '@linka/shared';
import { CONVERSATION_ID, OTHER_USER_ID } from '../test/messages';
import { latestChannel, realtimeChannels, TEST_USER_ID } from '../test/supabaseMock';
import { useLiveConversation } from './useLiveConversation';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const MARIA = '5d7f9b1d-3f5b-4d7f-9b1d-3f5b7d9f1b3d';
const ANA = '9f1b3d5f-7b9d-4f1b-8d5f-7b9d1f3b5d7f';
const STRANGER = '1a3c5e7a-9c1e-4a3c-8e7a-9c1e3a5c7e9a';
const members = new Set([TEST_USER_ID, OTHER_USER_ID, MARIA, ANA]);

const typing = (userId: string, isTyping = true) => ({ conversationId: CONVERSATION_ID, userId, typing: isTyping });

async function renderLive(enabled = true) {
  const hook = renderHook(({ on }) => useLiveConversation(CONVERSATION_ID, TEST_USER_ID, members, on), {
    initialProps: { on: enabled },
  });
  // setAuth resolves, then the channel subscribes.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return hook;
}

const channel = () => latestChannel(liveTopic(CONVERSATION_ID));
const joinLive = () => act(() => channel().join());

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('presence', () => {
  it('joins the private live channel keyed by my id and tracks me once joined', async () => {
    await renderLive();
    expect(channel().options).toEqual({ config: { private: true, presence: { key: TEST_USER_ID } } });
    await joinLive();
    expect(channel().tracked).toEqual([{ userId: TEST_USER_ID }]);
  });

  it('reports other members who have the conversation open, not me and not strangers', async () => {
    const { result } = await renderLive();
    await joinLive();

    act(() =>
      channel().setPresence({
        [TEST_USER_ID]: [{ userId: TEST_USER_ID }],
        [OTHER_USER_ID]: [{ userId: OTHER_USER_ID, presence_ref: 'x' }],
        [STRANGER]: [{ userId: STRANGER }],
        broken: [{ nope: true }],
      }),
    );
    expect(result.current.onlineUserIds).toEqual([OTHER_USER_ID]);

    act(() => channel().setPresence({}));
    expect(result.current.onlineUserIds).toEqual([]);
  });

  it('forgets everyone when the connection drops', async () => {
    const { result } = await renderLive();
    await joinLive();
    act(() => channel().setPresence({ [OTHER_USER_ID]: [{ userId: OTHER_USER_ID }] }));
    act(() => channel().emit('typing', typing(OTHER_USER_ID)));

    act(() => channel().fail('CHANNEL_ERROR'));
    expect(result.current.onlineUserIds).toEqual([]);
    expect(result.current.typingUserIds).toEqual([]);
  });

  it('does not join before access is confirmed', async () => {
    await renderLive(false);
    expect(realtimeChannels.filter((c) => c.topic === liveTopic(CONVERSATION_ID))).toHaveLength(0);
  });
});

describe('receiving typing', () => {
  it('shows who is typing and expires them after ~3 seconds without a new event', async () => {
    const { result } = await renderLive();
    await joinLive();

    act(() => channel().emit('typing', typing(OTHER_USER_ID)));
    expect(result.current.typingUserIds).toEqual([OTHER_USER_ID]);

    await act(() => vi.advanceTimersByTimeAsync(2900));
    expect(result.current.typingUserIds).toEqual([OTHER_USER_ID]);

    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current.typingUserIds).toEqual([]);
  });

  it('keeps someone typing while their events keep coming', async () => {
    const { result } = await renderLive();
    await joinLive();
    for (let i = 0; i < 4; i++) {
      act(() => channel().emit('typing', typing(OTHER_USER_ID)));
      await act(() => vi.advanceTimersByTimeAsync(2000));
    }
    expect(result.current.typingUserIds).toEqual([OTHER_USER_ID]);
  });

  it('tracks several people typing at once, and clears one who stops', async () => {
    const { result } = await renderLive();
    await joinLive();

    act(() => channel().emit('typing', typing(OTHER_USER_ID)));
    act(() => channel().emit('typing', typing(MARIA)));
    act(() => channel().emit('typing', typing(ANA)));
    expect(result.current.typingUserIds.sort()).toEqual([OTHER_USER_ID, MARIA, ANA].sort());

    act(() => channel().emit('typing', typing(MARIA, false)));
    expect(result.current.typingUserIds.sort()).toEqual([OTHER_USER_ID, ANA].sort());
  });

  it('ignores myself, non-members, other conversations and malformed events', async () => {
    const { result } = await renderLive();
    await joinLive();

    act(() => channel().emit('typing', typing(TEST_USER_ID)));
    act(() => channel().emit('typing', typing(STRANGER)));
    act(() => channel().emit('typing', { ...typing(OTHER_USER_ID), conversationId: STRANGER }));
    act(() => channel().emit('typing', { userId: OTHER_USER_ID }));
    expect(result.current.typingUserIds).toEqual([]);
  });

  it('clears when leaving the conversation', async () => {
    const { result, rerender } = await renderLive();
    await joinLive();
    act(() => channel().emit('typing', typing(OTHER_USER_ID)));

    rerender({ on: false });
    expect(result.current.typingUserIds).toEqual([]);
    expect(channel().removed).toBe(true);
  });
});

describe('sending typing', () => {
  const sentTyping = () => channel().sent.filter((s) => s.event === 'typing').map((s) => (s.payload as { typing: boolean }).typing);

  it('sends at most one event every 2 seconds while typing, then "stopped" after 3 seconds idle', async () => {
    const { result } = await renderLive();
    await joinLive();

    for (let i = 0; i < 10; i++) {
      act(() => result.current.notifyTyping());
      await act(() => vi.advanceTimersByTimeAsync(250)); // 10 keystrokes over 2.5s
    }
    expect(sentTyping()).toEqual([true, true]);

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(sentTyping()).toEqual([true, true, false]);
    expect(channel().sent[0]!.payload).toEqual(typing(TEST_USER_ID));
  });

  it('sends "stopped" right away when the message is sent', async () => {
    const { result } = await renderLive();
    await joinLive();
    act(() => result.current.notifyTyping());
    act(() => result.current.stopTyping());
    expect(sentTyping()).toEqual([true, false]);
  });

  it('sends "stopped" when leaving mid-typing', async () => {
    const { result, unmount } = await renderLive();
    await joinLive();
    act(() => result.current.notifyTyping());
    unmount();
    expect(sentTyping()).toEqual([true, false]);
  });

  it('sends nothing before the channel is joined', async () => {
    const { result } = await renderLive();
    act(() => result.current.notifyTyping());
    expect(sentTyping()).toEqual([]);
  });
});
