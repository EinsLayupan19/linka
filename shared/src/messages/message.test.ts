import { describe, expect, it } from 'vitest';
import { compareMessages, conversationTopic, messagePageQuerySchema } from './message.js';

describe('messagePageQuerySchema', () => {
  it('defaults to 50 and accepts a numeric string', () => {
    expect(messagePageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(messagePageQuerySchema.parse({ limit: '20', before: 'abc' })).toEqual({ limit: 20, before: 'abc' });
  });

  it.each(['0', '101', '-5', '2.5', 'lots'])('rejects limit=%j', (limit) => {
    expect(messagePageQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects an empty or oversized cursor', () => {
    expect(messagePageQuerySchema.safeParse({ before: '' }).success).toBe(false);
    expect(messagePageQuerySchema.safeParse({ before: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('compareMessages', () => {
  const at = (createdAt: string, id: string) => ({ createdAt, id });

  it('orders by timestamp first', () => {
    expect(compareMessages(at('2026-10-22T10:00:00.000Z', 'b'), at('2026-10-22T10:00:01.000Z', 'a'))).toBeLessThan(0);
  });

  it('breaks identical timestamps by id, deterministically', () => {
    const same = '2026-10-22T10:00:00.000Z';
    const sorted = [at(same, 'c'), at(same, 'a'), at(same, 'b')].sort(compareMessages).map((m) => m.id);
    expect(sorted).toEqual(['a', 'b', 'c']);
    expect(compareMessages(at(same, 'a'), at(same, 'a'))).toBe(0);
  });
});

describe('conversationTopic', () => {
  it('names the private channel of a conversation', () => {
    expect(conversationTopic('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      'conversation:0f8fad5b-d9cb-469f-a165-70867728950e',
    );
  });
});
