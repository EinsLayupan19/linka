import { sql } from 'drizzle-orm';
import { check, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid, authUsers } from 'drizzle-orm/supabase';

/**
 * One row per Supabase Auth user. Email stays in auth.users and is never copied here.
 *
 * RLS is deny-by-default: the only policy lets a signed-in user read their own row.
 * There are deliberately no insert/update/delete policies: all writes go through the
 * API, which validates input. (The API's database role bypasses RLS.)
 */
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    username: text('username').notNull().unique('profiles_username_unique'),
    displayName: text('display_name').notNull(),
    /** Storage path of the avatar image (uploads arrive in the media phase). */
    avatarPath: text('avatar_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Same rules as the shared Zod schemas, enforced again by the database.
    check('profiles_username_format', sql`${table.username} ~ '^[a-z0-9_]{3,20}$'`),
    check(
      'profiles_display_name_length',
      sql`char_length(${table.displayName}) <= 50 and btrim(${table.displayName}) <> ''`,
    ),
    pgPolicy('profiles_select_own', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${table.id} = ${authUid}`,
    }),
  ],
).enableRLS();

export type ProfileRow = typeof profiles.$inferSelect;
