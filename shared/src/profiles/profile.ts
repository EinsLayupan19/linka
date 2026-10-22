import { z } from 'zod';

// Keep in sync with the CHECK constraints on the profiles table (backend/src/db/schema/profiles.ts).
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const USERNAME_PATTERN = /^[a-z0-9_]+$/;
export const DISPLAY_NAME_MAX_LENGTH = 50;

/** Usernames are stored lowercase so "Maya" and "maya" cannot both exist. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN_LENGTH, `Use at least ${USERNAME_MIN_LENGTH} characters.`)
  .max(USERNAME_MAX_LENGTH, `Use at most ${USERNAME_MAX_LENGTH} characters.`)
  .regex(USERNAME_PATTERN, 'Use only letters, numbers and underscores.');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a display name.')
  .max(DISPLAY_NAME_MAX_LENGTH, `Use at most ${DISPLAY_NAME_MAX_LENGTH} characters.`);

/** Body of POST /api/users/me. Unknown fields (such as `id`) are rejected. */
export const createProfileSchema = z.strictObject({
  username: usernameSchema,
  displayName: displayNameSchema,
});

export type CreateProfileInput = z.infer<typeof createProfileSchema>;

/** Body of PATCH /api/users/me. */
export const updateProfileSchema = z.strictObject({
  displayName: displayNameSchema,
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** A profile as returned by the API. */
export const profileSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  /** Storage path of the avatar image. Uploads arrive in the media phase. */
  avatarPath: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type Profile = z.infer<typeof profileSchema>;

/** The public part of a profile that other users may see. Never includes email. */
export const userSummarySchema = profileSchema.pick({
  id: true,
  username: true,
  displayName: true,
  avatarPath: true,
});

export type UserSummary = z.infer<typeof userSummarySchema>;

/**
 * "Last seen" is reported by the client on app start, when the tab is hidden, and at this
 * interval while visible. The server ignores reports less than LAST_SEEN_MIN_GAP_SECONDS apart,
 * so last_seen_at can never become a high-write workload.
 */
export const LAST_SEEN_REPORT_INTERVAL_MS = 5 * 60_000;
export const LAST_SEEN_MIN_GAP_SECONDS = 60;

export const USER_SEARCH_MIN_LENGTH = 2;
export const USER_SEARCH_LIMIT = 20;

/** Query of GET /api/users/search: a username prefix, at least 2 characters. */
export const userSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .toLowerCase()
    .min(USER_SEARCH_MIN_LENGTH, `Type at least ${USER_SEARCH_MIN_LENGTH} characters.`)
    .max(USERNAME_MAX_LENGTH, `Usernames are at most ${USERNAME_MAX_LENGTH} characters.`),
});

export const userSearchResultSchema = z.object({
  users: z.array(userSummarySchema),
});

export type UserSearchResult = z.infer<typeof userSearchResultSchema>;
