import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// Runs the real Drizzle migrations against an in-memory Postgres (PGlite)
// to check what the database itself enforces, independent of the API.

let t: TestDatabase;
let maya: string;
let jonas: string;

async function insertProfile(id: string, username: string, displayName = username) {
  await t.client.query('insert into profiles (id, username, display_name) values ($1, $2, $3)', [
    id,
    username,
    displayName,
  ]);
}

beforeAll(async () => {
  t = await createTestDatabase();
  maya = await t.createAuthUser('maya@example.test');
  jonas = await t.createAuthUser('jonas@example.test');
  await insertProfile(maya, 'maya', 'Maya Reyes');
  await insertProfile(jonas, 'jonas', 'Jonas Lindqvist');
});

afterAll(async () => {
  await t.close();
});

describe('profiles migration', () => {
  it('enables row level security on profiles', async () => {
    const { rows } = await t.client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'profiles'",
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  it('defines only a select policy (no write policies)', async () => {
    const { rows } = await t.client.query<{ policyname: string; cmd: string; roles: string }>(
      "select policyname, cmd, roles::text from pg_policies where tablename = 'profiles'",
    );
    expect(rows).toEqual([{ policyname: 'profiles_select_own', cmd: 'SELECT', roles: '{authenticated}' }]);
  });
});

describe('profiles RLS', () => {
  it('lets a signed-in user read only their own profile', async () => {
    const rows = await t.asRole('authenticated', maya, async (tx) => (await tx.query('select username from profiles')).rows);
    expect(rows).toEqual([{ username: 'maya' }]);
  });

  it('does not let a signed-in user read someone else by id', async () => {
    const rows = await t.asRole(
      'authenticated',
      maya,
      async (tx) => (await tx.query('select * from profiles where id = $1', [jonas])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('hides every profile from anonymous requests', async () => {
    const rows = await t.asRole('anon', null, async (tx) => (await tx.query('select * from profiles')).rows);
    expect(rows).toEqual([]);
  });

  it('blocks direct inserts, even of your own profile', async () => {
    const newUser = await t.createAuthUser();
    await expect(
      t.asRole('authenticated', newUser, (tx) =>
        tx.query("insert into profiles (id, username, display_name) values ($1, 'sneaky', 'Sneaky')", [newUser]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('blocks direct updates of any profile', async () => {
    const changed = await t.asRole('authenticated', maya, async (tx) => {
      const own = await tx.query("update profiles set display_name = 'Hacked' where id = $1", [maya]);
      const other = await tx.query("update profiles set display_name = 'Hacked' where id = $1", [jonas]);
      return [own.affectedRows, other.affectedRows];
    });
    expect(changed).toEqual([0, 0]);

    const { rows } = await t.client.query<{ display_name: string }>('select display_name from profiles order by username');
    expect(rows.map((r) => r.display_name)).toEqual(['Jonas Lindqvist', 'Maya Reyes']);
  });

  it('blocks direct deletes', async () => {
    const deleted = await t.asRole('authenticated', maya, async (tx) => (await tx.query('delete from profiles')).affectedRows);
    expect(deleted).toBe(0);
  });
});

describe('profiles constraints', () => {
  it.each([
    ['Maya_Upper', 'uppercase'],
    ['ab', 'too short'],
    ['a'.repeat(21), 'too long'],
    ['has space', 'spaces'],
  ])('rejects the username %j (%s)', async (username) => {
    const id = await t.createAuthUser();
    await expect(insertProfile(id, username)).rejects.toThrow(/profiles_username_format/);
  });

  it('rejects a blank or over-long display name', async () => {
    const id = await t.createAuthUser();
    await expect(insertProfile(id, 'blank_name', '   ')).rejects.toThrow(/profiles_display_name_length/);
    await expect(insertProfile(id, 'long_name', 'x'.repeat(51))).rejects.toThrow(/profiles_display_name_length/);
  });

  it('rejects a duplicate username', async () => {
    const id = await t.createAuthUser();
    await expect(insertProfile(id, 'maya')).rejects.toThrow(/profiles_username_unique/);
  });

  it('requires a matching auth user', async () => {
    await expect(insertProfile('5d8e2a4c-0b1f-4c3e-9a7d-6f2b1e8c9d0a', 'ghost')).rejects.toThrow(
      /profiles_id_users_id_fk/,
    );
  });

  it('deletes the profile when the auth user is deleted', async () => {
    const id = await t.createAuthUser();
    await insertProfile(id, 'short_lived');
    await t.client.query('delete from auth.users where id = $1', [id]);

    const { rows } = await t.client.query('select 1 from profiles where id = $1', [id]);
    expect(rows).toEqual([]);
  });
});
