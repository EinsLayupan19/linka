import { describe, expect, it } from 'vitest';
import type { ConversationMember } from '@linka/shared';
import { noMarkers } from '../test/messages';
import { receiptLabel, typingLabel, unreadBadge, withMarkers } from './receipts';

const ME = 'me';
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, seconds)).toISOString();

function member(userId: string, markers: Partial<Pick<ConversationMember, 'lastDeliveredAt' | 'lastReadAt'>> = {}): ConversationMember {
  return { userId, role: 'member', joinedAt: at(0), username: userId, displayName: userId, avatarPath: null, ...noMarkers, ...markers };
}

describe('receiptLabel (1:1)', () => {
  const message = { createdAt: at(10) };
  const direct = (other: ConversationMember) => ({ type: 'direct' as const, members: [member(ME), other] });

  it('is Sent until the other person’s client received it', () => {
    expect(receiptLabel(message, direct(member('jonas', { lastDeliveredAt: at(9) })), ME)).toBe('Sent');
  });

  it('is Delivered once their delivery marker reaches the message', () => {
    expect(receiptLabel(message, direct(member('jonas', { lastDeliveredAt: at(10) })), ME)).toBe('Delivered');
  });

  it('is Read once their read marker reaches it', () => {
    expect(receiptLabel(message, direct(member('jonas', { lastDeliveredAt: at(12), lastReadAt: at(11) })), ME)).toBe('Read');
  });

  it('ignores my own markers', () => {
    const conversation = { type: 'direct' as const, members: [member(ME, { lastReadAt: at(99) }), member('jonas')] };
    expect(receiptLabel(message, conversation, ME)).toBe('Sent');
  });
});

describe('receiptLabel (group)', () => {
  const message = { createdAt: at(10) };

  it('counts only members whose read marker is at or after the message', () => {
    const group = {
      type: 'group' as const,
      members: [
        member(ME, { lastReadAt: at(50) }),
        member('a', { lastReadAt: at(10) }),
        member('b', { lastReadAt: at(30) }),
        member('c', { lastReadAt: at(9), lastDeliveredAt: at(20) }),
      ],
    };
    expect(receiptLabel(message, group, ME)).toBe('Read by 2');
  });

  it('falls back to Delivered, then Sent', () => {
    expect(receiptLabel(message, { type: 'group', members: [member(ME), member('a', { lastDeliveredAt: at(10) })] }, ME)).toBe('Delivered');
    expect(receiptLabel(message, { type: 'group', members: [member(ME), member('a')] }, ME)).toBe('Sent');
  });
});

describe('withMarkers', () => {
  it('moves markers forward only', () => {
    const members = [member('a', { lastReadAt: at(20), lastDeliveredAt: at(20) })];
    const updated = withMarkers(members, { userId: 'a', lastReadAt: at(10), lastDeliveredAt: at(30) });
    expect(updated[0]).toMatchObject({ lastReadAt: at(20), lastDeliveredAt: at(30) });
  });

  it('returns the same array when nothing changes', () => {
    const members = [member('a', { lastReadAt: at(20) })];
    expect(withMarkers(members, { userId: 'a', lastReadAt: at(5), lastDeliveredAt: null })).toBe(members);
    expect(withMarkers(members, { userId: 'stranger', lastReadAt: at(99), lastDeliveredAt: null })).toBe(members);
  });
});

describe('labels', () => {
  it('summarizes who is typing', () => {
    expect(typingLabel([])).toBeNull();
    expect(typingLabel(['John'])).toBe('John is typing…');
    expect(typingLabel(['John', 'Maria'])).toBe('John and Maria are typing…');
    expect(typingLabel(['John', 'Maria', 'Ana'])).toBe('3 people are typing…');
  });

  it('caps the unread badge at 99+', () => {
    expect(unreadBadge(7)).toBe('7');
    expect(unreadBadge(99)).toBe('99');
    expect(unreadBadge(100)).toBe('99+');
  });
});
