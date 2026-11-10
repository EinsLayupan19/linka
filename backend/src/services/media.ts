import type { StorageGateway } from './storage.js';

/** Profile picture URLs live an hour; any API response that includes a user carries a valid one. */
export const AVATAR_URL_TTL_SECONDS = 3600;
/**
 * A cached URL is handed out again only while it has at least this long left, so a client always
 * gets a URL that keeps working for a while after the response.
 */
export const AVATAR_URL_MIN_REMAINING_SECONDS = 15 * 60;
/** Enough for every picture a small deployment shows; the oldest entries go first. */
const DEFAULT_MAX_ENTRIES = 2000;

/** Turns private avatar storage paths into short-lived signed URLs. */
export interface MediaUrls {
  avatarUrls(paths: (string | null)[]): Promise<Map<string, string>>;
}

/**
 * Signed URLs are cached per storage path and reused until they get close to expiring. Two wins:
 * most requests make no Storage call at all, and a picture keeps the same URL across responses,
 * so the browser loads it from its cache instead of downloading it again (and it does not flicker
 * every time the conversation list refreshes).
 *
 * Reusing a URL for different viewers grants nothing new: every avatar path is unique per upload
 * (a new random name each time), and anyone who can see a user already gets a URL for it.
 */
export function createMediaUrls(
  storage: StorageGateway | null,
  options: { now?: () => number; maxEntries?: number } = {},
): MediaUrls {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, { url: string; expiresAt: number }>();

  function usable(path: string): string | undefined {
    const entry = cache.get(path);
    if (!entry) return undefined;
    if (entry.expiresAt - now() >= AVATAR_URL_MIN_REMAINING_SECONDS * 1000) return entry.url;
    cache.delete(path);
    return undefined;
  }

  function remember(path: string, url: string, expiresAt: number) {
    cache.delete(path); // re-inserted at the end: Map order is insertion order, oldest first
    cache.set(path, { url, expiresAt });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
  }

  return {
    async avatarUrls(paths) {
      const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))];
      const result = new Map<string, string>();
      if (!storage || unique.length === 0) return result;

      const missing: string[] = [];
      for (const path of unique) {
        const url = usable(path);
        if (url) result.set(path, url);
        else missing.push(path);
      }
      if (missing.length === 0) return result;

      const expiresAt = now() + AVATAR_URL_TTL_SECONDS * 1000;
      try {
        // One signing call for every picture not cached yet.
        const signed = await storage.signedUrls('avatars', missing, AVATAR_URL_TTL_SECONDS);
        for (const [path, url] of signed) {
          remember(path, url, expiresAt);
          result.set(path, url);
        }
      } catch {
        // A picture is not worth failing the request: these show initials instead.
      }
      return result;
    },
  };
}

/** For tests and unconfigured servers: nobody has a picture URL. */
export const noMediaUrls: MediaUrls = { avatarUrls: async () => new Map() };
