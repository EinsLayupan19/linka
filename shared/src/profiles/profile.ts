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
