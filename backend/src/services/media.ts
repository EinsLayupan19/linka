import type { StorageGateway } from './storage.js';

/** Profile picture URLs live an hour; any API response that includes a user carries a fresh one. */
export const AVATAR_URL_TTL_SECONDS = 3600;

/** Turns private avatar storage paths into short-lived signed URLs, one Storage call per batch. */
export interface MediaUrls {
  avatarUrls(paths: (string | null)[]): Promise<Map<string, string>>;
}

export function createMediaUrls(storage: StorageGateway | null): MediaUrls {
  return {
    async avatarUrls(paths) {
      const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))];
      if (!storage || unique.length === 0) return new Map();
      try {
        return await storage.signedUrls('avatars', unique, AVATAR_URL_TTL_SECONDS);
      } catch {
        // A picture is not worth failing the request: show initials instead.
        return new Map();
      }
    },
  };
}

/** For tests and unconfigured servers: nobody has a picture URL. */
export const noMediaUrls: MediaUrls = { avatarUrls: async () => new Map() };
