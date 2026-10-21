import { conversationListSchema, conversationSchema, type Conversation } from '@linka/shared';
import { apiRequest } from '../lib/api';

export async function listConversations(signal?: AbortSignal): Promise<Conversation[]> {
  const { conversations } = await apiRequest('/api/conversations', conversationListSchema, {
    auth: true,
    signal: signal ?? null,
  });
  return conversations;
}

export function getConversation(conversationId: string, signal?: AbortSignal): Promise<Conversation> {
  return apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}`, conversationSchema, {
    auth: true,
    signal: signal ?? null,
  });
}

/** Opens the 1:1 conversation with `userId`, creating it if it does not exist yet. */
export function startDirectConversation(userId: string): Promise<Conversation> {
  return apiRequest('/api/conversations', conversationSchema, {
    auth: true,
    method: 'POST',
    json: { type: 'direct', userId },
  });
}
