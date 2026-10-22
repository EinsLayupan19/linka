import { randomUUID } from 'node:crypto';
import { and, asc, eq, like, ne, sql } from 'drizzle-orm';
import {
  AVATAR_CONTENT_TYPES,
  ErrorCode,
  LAST_SEEN_MIN_GAP_SECONDS,
  MAX_AVATAR_BYTES,
  type AvatarContentType,
  type CreateProfileInput,
  type Profile,
  type UpdateProfileInput,
  type UserSummary,
} from '@linka/shared';
import type { Database } from '../db/client.js';
import { FOREIGN_KEY_VIOLATION, postgresErrorCode, UNIQUE_VIOLATION } from '../db/errors.js';
import { profiles, type ProfileRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { matchesSignature } from '../utils/fileSignature.js';
import { noMediaUrls, type MediaUrls } from './media.js';
import type { StorageGateway } from './storage.js';

/** Profile operations. Write methods act on the given user's own profile only. */
export interface ProfileStore {
  findById(userId: string): Promise<Profile | null>;
  create(userId: string, input: CreateProfileInput): Promise<Profile>;
  update(userId: string, input: UpdateProfileInput): Promise<Profile | null>;
  /**
   * Records that the user is active (for "Last seen"). Throttled in the database: a report
   * less than LAST_SEEN_MIN_GAP_SECONDS after the previous one does not write.
   */
  markSeen(userId: string): Promise<void>;
  /** Public summaries of users whose username starts with `prefix` (already lowercase). */
  searchByUsername(prefix: string, options: { excludeUserId: string; limit: number }): Promise<UserSummary[]>;
  /** Replaces the caller's profile picture with `body` (checked: type, size, real content). */
  setAvatar(userId: string, body: Uint8Array, contentType: string): Promise<Profile>;
  removeAvatar(userId: string): Promise<Profile>;
}

const AVATAR_EXTENSIONS: Record<AvatarContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Escapes LIKE wildcards so user input only ever matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const noProfile = () => new AppError(404, ErrorCode.ProfileNotFound, 'You have not set up your profile yet.');

export function createProfileStore(
  db: Database,
  media: MediaUrls = noMediaUrls,
  storage: StorageGateway | null = null,
): ProfileStore {
  async function toProfile(row: ProfileRow): Promise<Profile> {
    const urls = await media.avatarUrls([row.avatarPath]);
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: (row.avatarPath && urls.get(row.avatarPath)) || null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function findRow(userId: string) {
    const [row] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    return row;
  }

  async function findById(userId: string): Promise<Profile | null> {
    const row = await findRow(userId);
    return row ? toProfile(row) : null;
  }

  function requireStorage(): StorageGateway {
    if (!storage) throw new AppError(503, ErrorCode.ServiceUnavailable, 'Profile pictures are not configured on the server.');
    return storage;
  }

  /** Points the profile at `path` (or none) and deletes the previous picture afterwards. */
  async function swapAvatar(userId: string, path: string | null): Promise<Profile> {
    const previous = await findRow(userId);
    if (!previous) throw noProfile();
    const [row] = await db.update(profiles).set({ avatarPath: path }).where(eq(profiles.id, userId)).returning();
    if (!row) throw noProfile();
    if (previous.avatarPath && previous.avatarPath !== path) {
      // Best effort: an old picture left behind is harmless (nothing points at it).
      await storage?.remove('avatars', [previous.avatarPath]).catch(() => undefined);
    }
    return toProfile(row);
  }

  return {
    findById,

    async create(userId, input) {
      try {
        const [row] = await db
          .insert(profiles)
          .values({ id: userId, username: input.username, displayName: input.displayName })
          .returning();
        if (!row) throw new Error('Insert returned no row');
        return toProfile(row);
      } catch (error) {
        const code = postgresErrorCode(error);
        if (code === UNIQUE_VIOLATION) {
          // Either this user already has a profile, or someone else owns the username.
          if (await findRow(userId)) {
            throw new AppError(409, ErrorCode.ProfileExists, 'Your profile is already set up.');
          }
          throw new AppError(409, ErrorCode.UsernameTaken, 'That username is taken.', {
            username: 'That username is taken.',
          });
        }
        if (code === FOREIGN_KEY_VIOLATION) {
          // The token is valid but the auth user was deleted.
          throw new AppError(401, ErrorCode.Unauthorized, 'Your account no longer exists.');
        }
        throw error;
      }
    },

    async update(userId, input) {
      const [row] = await db
        .update(profiles)
        .set({ displayName: input.displayName })
        .where(eq(profiles.id, userId))
        .returning();
      return row ? toProfile(row) : null;
    },

    async markSeen(userId) {
      await db
        .update(profiles)
        .set({ lastSeenAt: sql`now()` })
        .where(
          and(
            eq(profiles.id, userId),
            sql`(${profiles.lastSeenAt} is null or ${profiles.lastSeenAt} < now() - make_interval(secs => ${LAST_SEEN_MIN_GAP_SECONDS}))`,
          ),
        );
    },

    async searchByUsername(prefix, { excludeUserId, limit }) {
      // Usernames are stored lowercase, so a plain prefix LIKE on a lowercased query is
      // case-insensitive and can use the text_pattern_ops index.
      const rows = await db
        .select({
          id: profiles.id,
          username: profiles.username,
          displayName: profiles.displayName,
          avatarPath: profiles.avatarPath,
        })
        .from(profiles)
        .where(and(like(profiles.username, `${escapeLike(prefix)}%`), ne(profiles.id, excludeUserId)))
        // Exact match first, then alphabetical.
        .orderBy(sql`${profiles.username} = ${prefix} desc`, asc(profiles.username))
        .limit(limit);
      const urls = await media.avatarUrls(rows.map((r) => r.avatarPath));
      return rows.map(({ avatarPath, ...user }) => ({ ...user, avatarUrl: (avatarPath && urls.get(avatarPath)) || null }));
    },

    async setAvatar(userId, body, contentType) {
      const gateway = requireStorage();
      if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        throw new AppError(415, ErrorCode.UnsupportedMediaType, 'Use a JPEG, PNG or WebP image.');
      }
      if (body.byteLength === 0) throw new AppError(400, ErrorCode.ValidationFailed, 'The image is empty.');
      if (body.byteLength > MAX_AVATAR_BYTES) {
        throw new AppError(413, ErrorCode.PayloadTooLarge, 'Profile pictures can be at most 2 MB.');
      }
      if (!matchesSignature(body, contentType)) {
        throw new AppError(422, ErrorCode.UploadRejected, 'The file content does not match its type.');
      }
      if (!(await findRow(userId))) throw noProfile();

      // A new random name each time: no overwrite, and old URLs stop working after the swap.
      const path = `${userId}/${randomUUID()}.${AVATAR_EXTENSIONS[contentType as AvatarContentType]}`;
      await gateway.upload('avatars', path, body, contentType);
      try {
        return await swapAvatar(userId, path);
      } catch (error) {
        await gateway.remove('avatars', [path]).catch(() => undefined);
        throw error;
      }
    },

    async removeAvatar(userId) {
      return swapAvatar(userId, null);
    },
  };
}
