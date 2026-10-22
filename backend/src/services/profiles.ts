import { and, asc, eq, like, ne, sql } from 'drizzle-orm';
import {
  ErrorCode,
  LAST_SEEN_MIN_GAP_SECONDS,
  type CreateProfileInput,
  type Profile,
  type UpdateProfileInput,
  type UserSummary,
} from '@linka/shared';
import type { Database } from '../db/client.js';
import { FOREIGN_KEY_VIOLATION, postgresErrorCode, UNIQUE_VIOLATION } from '../db/errors.js';
import { profiles, type ProfileRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';

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
}

function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarPath: row.avatarPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Escapes LIKE wildcards so user input only ever matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function createProfileStore(db: Database): ProfileStore {
  async function findById(userId: string): Promise<Profile | null> {
    const [row] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    return row ? toProfile(row) : null;
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
          if (await findById(userId)) {
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
      return db
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
    },
  };
}
