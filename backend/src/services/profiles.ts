import { eq } from 'drizzle-orm';
import { ErrorCode, type CreateProfileInput, type Profile, type UpdateProfileInput } from '@linka/shared';
import type { Database } from '../db/client.js';
import { profiles, type ProfileRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';

/** Profile operations. Every method acts on the given user's own profile only. */
export interface ProfileStore {
  findById(userId: string): Promise<Profile | null>;
  create(userId: string, input: CreateProfileInput): Promise<Profile>;
  update(userId: string, input: UpdateProfileInput): Promise<Profile | null>;
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

// Drizzle wraps driver errors, so check the error and its cause for a Postgres error code.
function postgresErrorCode(error: unknown): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

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
  };
}
