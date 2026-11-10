/**
 * Start-up prefetching: requests the signed-in screens need are started as soon as the session is
 * known, in parallel with the profile, instead of one after the other (session, then profile,
 * then the conversation list, then the open conversation).
 *
 * Rules that keep it safe:
 * - a prefetched result is used at most once, by the first load of that screen; every later load
 *   (a refetch after the realtime channel joins, a retry) asks the server again, so nothing sent in
 *   between can be missed
 * - unused results expire after PREFETCH_MAX_AGE_MS
 * - signing out clears everything (see AuthProvider), and keys include the user id
 */
export const PREFETCH_MAX_AGE_MS = 30_000;

interface Entry {
  promise: Promise<unknown>;
  /** When the request finished; null while it is still running (always fresh then). */
  settledAt: number | null;
}

const entries = new Map<string, Entry>();

export const prefetchKeys = {
  conversations: (userId: string) => `${userId}:conversations`,
  conversation: (userId: string, conversationId: string) => `${userId}:conversation:${conversationId}`,
  messages: (userId: string, conversationId: string) => `${userId}:messages:${conversationId}`,
};

function isFresh(entry: Entry): boolean {
  return entry.settledAt === null || Date.now() - entry.settledAt <= PREFETCH_MAX_AGE_MS;
}

/** Starts `load` now, unless the same result is already waiting to be used. */
export function prefetch<T>(key: string, load: () => Promise<T>): void {
  const existing = entries.get(key);
  if (existing && isFresh(existing)) return;
  const entry: Entry = { promise: Promise.resolve(), settledAt: null };
  entry.promise = load().finally(() => {
    entry.settledAt = Date.now();
  });
  // Nobody may ever use it: a failure must not become an unhandled rejection.
  entry.promise.catch(() => undefined);
  entries.set(key, entry);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * The prefetched result for `key` if there is a fresh one (it is then used up), otherwise
 * `load(signal)`. A failed prefetch falls back to `load`. Aborting `signal` rejects with an
 * AbortError either way, so callers handle it exactly like an aborted fetch.
 */
export function loadWithPrefetch<T>(key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const entry = entries.get(key);
  entries.delete(key);
  if (!entry || !isFresh(entry)) return load(signal);
  if (signal.aborted) return Promise.reject(abortError());

  const prefetched = (entry.promise as Promise<T>).catch(() => load(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    prefetched.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Forgets every prefetched result (on sign-out, so nothing reaches the next user). */
export function clearPrefetched(): void {
  entries.clear();
}
