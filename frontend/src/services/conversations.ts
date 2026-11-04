import { conversationListSchema, conversationSchema, type Conversation, type MemberRole } from '@linka/shared';
import { z } from 'zod';
import { apiRequest } from '../lib/api';

const conversationPath = (conversationId: string) => `/api/conversations/${encodeURIComponent(conversationId)}`;
const memberPath = (conversationId: string, userId: string) =>
  `${conversationPath(conversationId)}/members/${encodeURIComponent(userId)}`;

export async function listConversations(signal?: AbortSignal): Promise<Conversation[]> {
  const { conversations } = await apiRequest('/api/conversations', conversationListSchema, {
    auth: true,
    signal: signal ?? null,
  });
  return conversations;
}

export function getConversation(conversationId: string, signal?: AbortSignal): Promise<Conversation> {
  return apiRequest(conversationPath(conversationId), conversationSchema, {
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

// --- Groups. The API checks every action against the caller's role (see permissions.ts). ---

/** Creates a group with the signed-in user as its owner. */
export function createGroup(name: string, memberIds: string[]): Promise<Conversation> {
  return apiRequest('/api/conversations', conversationSchema, {
    auth: true,
    method: 'POST',
    json: { type: 'group', name, memberIds },
  });
}

export function renameGroup(conversationId: string, name: string): Promise<Conversation> {
  return apiRequest(conversationPath(conversationId), conversationSchema, { auth: true, method: 'PATCH', json: { name } });
}

export function addGroupMembers(conversationId: string, userIds: string[]): Promise<Conversation> {
  return apiRequest(`${conversationPath(conversationId)}/members`, conversationSchema, {
    auth: true,
    method: 'POST',
    json: { userIds },
  });
}

/** Promote, demote, or (role "owner") transfer ownership; the old owner becomes an admin. */
export function setMemberRole(conversationId: string, userId: string, role: MemberRole): Promise<Conversation> {
  return apiRequest(memberPath(conversationId, userId), conversationSchema, { auth: true, method: 'PATCH', json: { role } });
}

/** Removes someone from the group; with your own id, leaves it. */
export async function removeGroupMember(conversationId: string, userId: string): Promise<void> {
  await apiRequest(memberPath(conversationId, userId), z.undefined(), { auth: true, method: 'DELETE' });
}
