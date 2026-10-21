import { userSearchResultSchema, type UserSummary } from '@linka/shared';
import { apiRequest } from '../lib/api';

/** Users whose username starts with `query` (at least 2 characters). Never includes you. */
export async function searchUsers(query: string, signal?: AbortSignal): Promise<UserSummary[]> {
  const { users } = await apiRequest(`/api/users/search?q=${encodeURIComponent(query)}`, userSearchResultSchema, {
    auth: true,
    signal: signal ?? null,
  });
  return users;
}
