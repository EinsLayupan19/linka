import type { Conversation, Message } from '@linka/shared';
import { TEST_USER_ID } from './supabaseMock';

export const CONVERSATION_ID = '6a1c3e5f-7b9d-4f2a-8c4e-0d2f4a6c8e1b';
export const OTHER_USER_ID = '8e0a2c4d-6f8b-4a1c-9e3d-5f7b9d1f3a5c';

let counter = 0;

/** A message; ids and timestamps increase with each call unless given. */
export function makeMessage(overrides: Partial<Message> = {}): Message {
  counter += 1;
  const n = String(counter).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${n}`,
    conversationId: CONVERSATION_ID,
    senderId: OTHER_USER_ID,
    clientId: null,
    type: 'text',
    content: `Message ${counter}`,
    createdAt: new Date(Date.UTC(2026, 9, 22, 9, 0, counter)).toISOString(),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION_ID,
    type: 'direct',
    name: null,
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
    members: [
      { userId: TEST_USER_ID, role: 'member', joinedAt: '2026-10-22T08:00:00.000Z', username: 'maya', displayName: 'Maya Reyes', avatarPath: null },
      { userId: OTHER_USER_ID, role: 'member', joinedAt: '2026-10-22T08:00:00.000Z', username: 'jonas', displayName: 'Jonas Lindqvist', avatarPath: null },
    ],
    lastMessage: null,
    ...overrides,
  };
}
