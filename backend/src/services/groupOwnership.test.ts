import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { createConversationStore, type ConversationStore } from './conversations.js';

// The ownership races, forced into their exact dangerous order. A "paused" store talks to the
// same database through a connection that stops at one chosen point (just before a transaction,
// or just before a given statement) until the other request has finished. Before Phase 10 both
// orders below left the group without an owner.

let t: TestDatabase;
let store: ConversationStore;

beforeAll(async () => {
  t = await createTestDatabase();
  store = createConversationStore(t.db);
});

afterAll(async () => {
  await t.close();
});

type Pause = { beforeTransaction: true } | { beforeStatement: RegExp };

/** A store whose database connection waits for `release` at the pause point (once). */
function pausedStore(pause: Pause, release: Promise<unknown>): { store: ConversationStore; reached: Promise<void> } {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let paused = false;
  const wait = async () => {
    if (paused) return;
    paused = true;
    reach();
    await release;
  };
  type Fn = (...args: unknown[]) => unknown;
  // Statements run on the client, or inside a transaction on the object PGlite hands to it.
  const intercept = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (property === 'transaction') {
          return async (run: (tx: object) => unknown, ...rest: unknown[]) => {
            if ('beforeTransaction' in pause) await wait();
            return (value as Fn).apply(object, [(tx: object) => run(intercept(tx)), ...rest]);
          };
        }
        if (property === 'query' && 'beforeStatement' in pause) {
          return async (sql: string, ...rest: unknown[]) => {
            if (pause.beforeStatement.test(sql)) await wait();
            return (value as Fn).apply(object, [sql, ...rest]);
          };
        }
        return (value as Fn).bind(object);
      },
    });
  const client = intercept(t.client) as PGlite;
  return { store: createConversationStore(drizzle(client, { schema }) as unknown as Database), reached };
}

async function group() {
  const [owner, member] = [await t.createUser(), await t.createUser()];
  const { conversation } = await store.create(owner, { type: 'group', name: 'Trip', memberIds: [member] });
  return { id: conversation.id, owner, member };
}

async function roles(conversationId: string): Promise<Record<string, string>> {
  const { rows } = await t.client.query<{ user_id: string; role: string }>(
    'select user_id, role from conversation_members where conversation_id = $1',
    [conversationId],
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: { statusCode?: number; code?: string }) => error.code ?? String(error.statusCode ?? error),
  );

describe('ownership transfer racing a removal', () => {
  it('the new owner removed after the transfer was checked: the transfer fails, the owner stays', async () => {
    const { id, owner, member } = await group();
    let removed!: () => void;
    const removal = new Promise<void>((resolve) => (removed = resolve));
    const paused = pausedStore({ beforeTransaction: true }, removal);

    const transfer = outcome(paused.store.updateMemberRole(owner, id, member, 'owner'));
    await paused.reached; // the transfer has done everything up to its transaction
    await store.removeMember(owner, id, member);
    removed();

    expect(await transfer).toBe('MEMBER_NOT_FOUND');
    expect(await roles(id)).toEqual({ [owner]: 'owner' });
  });

  it('a member’s leave checked before they were made owner: the leave fails, they stay the owner', async () => {
    const { id, owner, member } = await group();
    let transferred!: () => void;
    const transfer = new Promise<void>((resolve) => (transferred = resolve));
    // Pause the leave just before it deletes the membership row.
    const paused = pausedStore({ beforeStatement: /^delete from "conversation_members"/i }, transfer);

    const leave = outcome(paused.store.removeMember(member, id, member));
    await paused.reached;
    // While paused, the transfer either runs (old code) or waits for the leave's lock (new code).
    const done = outcome(store.updateMemberRole(owner, id, member, 'owner')).finally(transferred);
    // Never wait forever: if the transfer has to wait for the leave, let the leave go on.
    setTimeout(transferred, 100);

    const [leaveResult, transferResult] = await Promise.all([leave, done]);
    const final = await roles(id);
    expect(Object.values(final).filter((role) => role === 'owner')).toHaveLength(1);
    // Either the leave won (the transfer then finds nobody to promote) or the transfer won (the
    // leave is then refused, because owners must hand over first).
    if (leaveResult === 'ok') {
      expect(transferResult).toBe('MEMBER_NOT_FOUND');
      expect(final).toEqual({ [owner]: 'owner' });
    } else {
      expect(leaveResult).toBe('OWNER_CANNOT_LEAVE');
      expect(final).toEqual({ [owner]: 'admin', [member]: 'owner' });
    }
  });

  it('the owner removing someone they just made owner (two tabs): refused, one owner remains', async () => {
    const { id, owner, member } = await group();
    let transferred!: () => void;
    const transfer = new Promise<void>((resolve) => (transferred = resolve));
    const paused = pausedStore({ beforeStatement: /^delete from "conversation_members"/i }, transfer);

    const removal = outcome(paused.store.removeMember(owner, id, member));
    await paused.reached;
    const done = outcome(store.updateMemberRole(owner, id, member, 'owner')).finally(transferred);
    setTimeout(transferred, 100);

    const [removalResult] = await Promise.all([removal, done]);
    const final = await roles(id);
    expect(Object.values(final).filter((role) => role === 'owner')).toHaveLength(1);
    if (removalResult === 'ok') expect(final).toEqual({ [owner]: 'owner' });
    else expect(final[member]).toBe('owner');
  });
});

describe('normal ownership changes still work', () => {
  it('transfers ownership, and the old owner (now an admin) can leave', async () => {
    const { id, owner, member } = await group();
    await store.updateMemberRole(owner, id, member, 'owner');
    expect(await roles(id)).toEqual({ [owner]: 'admin', [member]: 'owner' });
    await store.removeMember(owner, id, owner);
    expect(await roles(id)).toEqual({ [member]: 'owner' });
  });

  it('refuses a transfer by someone who is not the owner, and removing the owner', async () => {
    const { id, owner, member } = await group();
    expect(await outcome(store.updateMemberRole(member, id, owner, 'owner'))).toBe('FORBIDDEN');
    expect(await outcome(store.removeMember(member, id, owner))).toBe('FORBIDDEN');
    expect(await outcome(store.removeMember(owner, id, owner))).toBe('OWNER_CANNOT_LEAVE');
    expect(await roles(id)).toEqual({ [owner]: 'owner', [member]: 'member' });
  });
});
