import { describe, expect, it } from 'vitest';
import { makeMessage } from '../test/messages';
import { mergeMessages } from './messageList';

describe('mergeMessages', () => {
  it('keeps one copy per message id', () => {
    const message = makeMessage();
    expect(mergeMessages([message], [message, message])).toEqual([message]);
  });

  it('orders by createdAt, not by arrival', () => {
    const [a, b, c] = [makeMessage(), makeMessage(), makeMessage()];
    expect(mergeMessages([c], [a, b]).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  it('breaks identical timestamps by id, whatever order they arrive in', () => {
    const at = '2026-10-22T09:00:00.000Z';
    const first = makeMessage({ id: '00000000-0000-4000-8000-00000000000a', createdAt: at });
    const second = makeMessage({ id: '00000000-0000-4000-8000-00000000000b', createdAt: at });
    expect(mergeMessages([second], [first])).toEqual([first, second]);
    expect(mergeMessages([first], [second])).toEqual([first, second]);
  });

  it('returns the same array when nothing arrives (no needless re-render)', () => {
    const list = [makeMessage()];
    expect(mergeMessages(list, [])).toBe(list);
  });
});
