import { useId, useState } from 'react';
import type { UserSummary } from '@linka/shared';
import { useUserSearch } from '../../hooks/useUserSearch';
import { Alert } from '../ui/Alert';
import { Avatar } from '../ui/Avatar';

interface PeoplePickerProps {
  label: string;
  selected: UserSummary[];
  onChange: (selected: UserSummary[]) => void;
  /** People who cannot be picked again (already in the group). */
  excludeIds?: ReadonlySet<string>;
  error?: string | undefined;
  disabled?: boolean;
}

/**
 * Choose several people by username: search, tap to add, tap a chosen person to take them out.
 * Selection is keyed by user id, so nobody can be chosen twice; you never appear in the results.
 */
export function PeoplePicker({ label, selected, onChange, excludeIds, error, disabled = false }: PeoplePickerProps) {
  const inputId = useId();
  const messageId = `${inputId}-message`;
  const [query, setQuery] = useState('');
  const { term, results } = useUserSearch(query);
  const selectedIds = new Set(selected.map((user) => user.id));

  const toggle = (user: UserSummary) =>
    onChange(selectedIds.has(user.id) ? selected.filter((u) => u.id !== user.id) : [...selected, user]);

  return (
    <div className="grid gap-2">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={inputId}
        type="search"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={messageId}
        placeholder="Start typing a username"
        className={
          'h-10 w-full rounded-lg border bg-surface px-3 text-base text-ink placeholder:text-ink-muted sm:text-sm ' +
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60 ' +
          (error ? 'border-danger' : 'border-field')
        }
      />
      <p id={messageId} className={`text-sm ${error ? 'text-danger' : 'text-ink-muted'}`}>
        {error ?? 'Search by username, then choose people.'}
      </p>

      {selected.length > 0 && (
        <ul aria-label="Chosen people" className="flex flex-wrap gap-2">
          {selected.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                onClick={() => toggle(user)}
                disabled={disabled}
                aria-label={`Remove ${user.displayName}`}
                className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-canvas pr-2.5 pl-1 text-sm hover:border-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
              >
                <Avatar name={user.displayName} src={user.avatarUrl} size="2xs" />
                <span className="max-w-[10rem] truncate">{user.displayName}</span>
                <span aria-hidden="true" className="text-ink-muted">
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div aria-live="polite">
        {results.status === 'loading' && <p className="text-sm text-ink-muted">Searching…</p>}
        {results.status === 'error' && <Alert tone="danger">{results.message}</Alert>}
        {results.status === 'ready' && results.users.length === 0 && (
          <p className="text-sm text-ink-muted">No one found with a username starting “{term}”.</p>
        )}
        {results.status === 'ready' && results.users.length > 0 && (
          <ul aria-label="Search results" className="grid gap-0.5">
            {results.users.map((user) => {
              const alreadyIn = excludeIds?.has(user.id) ?? false;
              const chosen = selectedIds.has(user.id);
              return (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => toggle(user)}
                    disabled={disabled || alreadyIn}
                    aria-pressed={alreadyIn ? undefined : chosen}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent disabled:opacity-60"
                  >
                    <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{user.displayName}</span>
                      <span className="block truncate text-xs text-ink-muted">@{user.username}</span>
                    </span>
                    <span className={`shrink-0 text-sm ${chosen ? 'font-medium text-accent' : 'text-ink-muted'}`}>
                      {alreadyIn ? 'Already in the group' : chosen ? 'Chosen' : 'Add'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
