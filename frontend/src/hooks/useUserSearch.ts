import { useEffect, useState } from 'react';
import { USER_SEARCH_MIN_LENGTH, type UserSummary } from '@linka/shared';
import { toApiError } from '../lib/api';
import { searchUsers } from '../services/users';

const SEARCH_DELAY_MS = 250;

export type UserSearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; users: UserSummary[] }
  | { status: 'error'; message: string };

/**
 * Username search while typing: after a short pause, cancelling the previous request, and only
 * once the query is long enough. Never returns the signed-in user (the API leaves them out).
 */
export function useUserSearch(query: string) {
  const [search, setSearch] = useState<UserSearchState>({ status: 'idle' });
  const term = query.trim();
  const searchable = term.length >= USER_SEARCH_MIN_LENGTH;

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearch({ status: 'loading' });
      searchUsers(term, controller.signal).then(
        (users) => setSearch({ status: 'ready', users }),
        (error: unknown) => {
          if (!controller.signal.aborted) setSearch({ status: 'error', message: toApiError(error).message });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, searchable]);

  const results: UserSearchState = searchable ? search : { status: 'idle' };
  return { term, results };
}
