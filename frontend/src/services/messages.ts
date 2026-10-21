import { messagePageSchema, messageSchema, type Message, type MessagePage } from '@linka/shared';
import { apiRequest } from '../lib/api';

const messagesPath = (conversationId: string) => `/api/conversations/${encodeURIComponent(conversationId)}/messages`;

/** One page of history, oldest first. Without `before`: the newest page. */
export function listMessages(
  conversationId: string,
  options: { before?: string | null; signal?: AbortSignal } = {},
): Promise<MessagePage> {
  const query = options.before ? `?before=${encodeURIComponent(options.before)}` : '';
  return apiRequest(`${messagesPath(conversationId)}${query}`, messagePageSchema, {
    auth: true,
    signal: options.signal ?? null,
  });
}

/**
 * Sends a text message. `clientId` identifies this send: retrying with the same clientId
 * returns the original message instead of creating a second one.
 */
export function sendMessage(conversationId: string, input: { content: string; clientId: string }): Promise<Message> {
  return apiRequest(messagesPath(conversationId), messageSchema, { auth: true, method: 'POST', json: input });
}
