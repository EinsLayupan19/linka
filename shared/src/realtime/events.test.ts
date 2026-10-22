import { describe, expect, it } from 'vitest';
import { markDeliveredSchema, markReadSchema } from '../conversations/markers.js';
import {
  conversationActivityEventSchema,
  conversationChangedEventSchema,
  liveTopic,
  receiptUpdatedEventSchema,
  typingEventSchema,
  userTopic,
} from './events.js';

const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('topics', () => {
  it('names the user and live channels', () => {
    expect(userTopic(id)).toBe(`user:${id}`);
    expect(liveTopic(id)).toBe(`live:${id}`);
  });
});

describe('event schemas', () => {
  it('accepts a typing event and rejects extra-shaped ones', () => {
    expect(typingEventSchema.safeParse({ conversationId: id, userId: other, typing: true }).success).toBe(true);
    expect(typingEventSchema.safeParse({ conversationId: id, userId: 'me', typing: true }).success).toBe(false);
    expect(typingEventSchema.safeParse({ conversationId: id, userId: other }).success).toBe(false);
  });

  it('requires a full message in conversation.activity', () => {
    expect(conversationActivityEventSchema.safeParse({ conversationId: id, lastMessage: { id } }).success).toBe(false);
  });

  it('accepts null markers in receipt.updated', () => {
    expect(
      receiptUpdatedEventSchema.safeParse({ conversationId: id, userId: other, lastDeliveredAt: null, lastReadAt: null })
        .success,
    ).toBe(true);
  });

  it('only knows three kinds of conversation change', () => {
    expect(conversationChangedEventSchema.safeParse({ conversationId: id, change: 'added' }).success).toBe(true);
    expect(conversationChangedEventSchema.safeParse({ conversationId: id, change: 'deleted' }).success).toBe(false);
  });
});

describe('marker inputs', () => {
  it('requires an ISO timestamp for reads and rejects a target user', () => {
    expect(markReadSchema.safeParse({ lastReadAt: '2026-10-22T10:00:00.000Z' }).success).toBe(true);
    expect(markReadSchema.safeParse({ lastReadAt: 'yesterday' }).success).toBe(false);
    expect(markReadSchema.safeParse({ lastReadAt: '2026-10-22T10:00:00.000Z', userId: other }).success).toBe(false);
  });

  it('batches deliveries, at most 50 at a time', () => {
    const item = { conversationId: id, lastDeliveredAt: '2026-10-22T10:00:00.000Z' };
    expect(markDeliveredSchema.safeParse({ conversations: [item] }).success).toBe(true);
    expect(markDeliveredSchema.safeParse({ conversations: [] }).success).toBe(false);
    expect(markDeliveredSchema.safeParse({ conversations: Array(51).fill(item) }).success).toBe(false);
    expect(markDeliveredSchema.safeParse({ conversations: [{ ...item, userId: other }] }).success).toBe(false);
  });
});
