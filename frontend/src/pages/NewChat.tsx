import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { USER_SEARCH_MIN_LENGTH, type UserSummary } from '@linka/shared';
import { Avatar } from '../components/ui/Avatar';
import { Alert } from '../components/ui/Alert';
import { useChats } from '../hooks/useChats';
import { toApiError } from '../lib/api';
import { startDirectConversation } from '../services/conversations';
import { searchUsers } from '../services/users';

const SEARCH_DELAY_MS = 250;

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; users: UserSummary[] }
  | { status: 'error'; message: string };

/** Find someone by username and open the 1:1 conversation with them. */
export function NewChat() {
  const navigate = useNavigate();
  const { upsertConversation } = useChats();
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const term = query.trim();
  const searchable = term.length >= USER_SEARCH_MIN_LENGTH;

  // Search while typing, after a short pause, cancelling the previous request.
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

  async function start(user: UserSummary) {
    setStarting(user.id);
    setStartError(null);
    try {
      const conversation = await startDirectConversation(user.id);
      upsertConversation(conversation);
      navigate(`/conversations/${conversation.id}`, { replace: true });
    } catch (error) {
      setStartError(toApiError(error).message);
      setStarting(null);
    }
  }

  const results = searchable ? search : ({ status: 'idle' } as const);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link
          to="/"
          className="rounded-lg px-1 text-sm font-medium text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:hidden"
        >
          Back
        </Link>
        <h1 className="font-semibold">New chat</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid max-w-md gap-2">
          <label htmlFor={inputId} className="text-sm font-medium">
            Username
          </label>
          <input
            id={inputId}
            type="search"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent sm:text-sm"
            placeholder="Start typing a username"
          />
          <p className="text-sm text-ink-muted">Search by username. Email addresses are never searchable.</p>
        </div>

        <div className="mt-6 max-w-md" aria-live="polite">
          {startError && <Alert tone="danger">{startError}</Alert>}
          {results.status === 'loading' && <p className="text-sm text-ink-muted">Searching…</p>}
          {results.status === 'error' && <Alert tone="danger">{results.message}</Alert>}
          {results.status === 'ready' && results.users.length === 0 && (
            <p className="text-sm text-ink-muted">No one found with a username starting “{term}”.</p>
          )}
          {results.status === 'ready' && results.users.length > 0 && (
            <ul className="grid gap-1" aria-label="People">
              {results.users.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => start(user)}
                    disabled={starting !== null}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
                  >
                    <Avatar name={user.displayName} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{user.displayName}</span>
                      <span className="block truncate text-sm text-ink-muted">@{user.username}</span>
                    </span>
                    {starting === user.id && <span className="ml-auto text-sm text-ink-muted">Opening…</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
