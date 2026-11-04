import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversationStore } from '../services/conversations.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

// The database itself keeps every group at exactly one owner: a unique index stops a second owner
// (since Phase 3), and a deferred check (migration 0011) stops a transaction from committing a
// group with none. These tests run the statements a lost race would produce, directly.

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

async function group() {
  const [owner, member] = [await t.createUser(), await t.createUser()];
  const { conversation } = await createConversationStore(t.db).create(owner, { type: 'group', name: 'Trip', memberIds: [member] });
  return { id: conversation.id, owner, member };
}

async function ownersOf(conversationId: string): Promise<string[]> {
  const { rows } = await t.client.query<{ user_id: string }>(
    "select user_id from conversation_members where conversation_id = $1 and role = 'owner'",
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

describe('a group always has exactly one owner', () => {
  it('refuses a transfer whose new owner was removed meanwhile (the old owner would just step down)', async () => {
    const { id, owner, member } = await group();
    // Someone removed the member a moment before the transfer's transaction ran.
    await t.client.query('delete from conversation_members where conversation_id = $1 and user_id = $2', [id, member]);

    const transfer = t.client.transaction(async (tx) => {
      await tx.query("update conversation_members set role = 'admin' where conversation_id = $1 and user_id = $2", [id, owner]);
      await tx.query("update conversation_members set role = 'owner' where conversation_id = $1 and user_id = $2", [id, member]);
    });

    await expect(transfer).rejects.toThrow(/must have an owner/);
    expect(await ownersOf(id)).toEqual([owner]);
  });

  it('refuses removing the owner, for example a leave that was checked before they became owner', async () => {
    const { id, owner } = await group();
    await expect(t.client.query('delete from conversation_members where conversation_id = $1 and user_id = $2', [id, owner])).rejects.toThrow(
      /must have an owner/,
    );
    expect(await ownersOf(id)).toEqual([owner]);
  });

  it('refuses demoting the owner without promoting someone else', async () => {
    const { id, owner } = await group();
    await expect(
      t.client.query("update conversation_members set role = 'admin' where conversation_id = $1 and user_id = $2", [id, owner]),
    ).rejects.toThrow(/must have an owner/);
  });

  it('allows a complete transfer in one transaction', async () => {
    const { id, owner, member } = await group();
    await t.client.transaction(async (tx) => {
      await tx.query("update conversation_members set role = 'admin' where conversation_id = $1 and user_id = $2", [id, owner]);
      await tx.query("update conversation_members set role = 'owner' where conversation_id = $1 and user_id = $2", [id, member]);
    });
    expect(await ownersOf(id)).toEqual([member]);
  });

  it('allows removing other members, and deleting the whole group', async () => {
    const { id, owner, member } = await group();
    await t.client.query('delete from conversation_members where conversation_id = $1 and user_id = $2', [id, member]);
    expect(await ownersOf(id)).toEqual([owner]);

    await t.client.query('delete from conversations where id = $1', [id]);
    const { rows } = await t.client.query('select 1 from conversation_members where conversation_id = $1', [id]);
    expect(rows).toEqual([]);
  });

  it('does not stop an owner’s account from being deleted (the group is then left without an owner)', async () => {
    const { id, owner, member } = await group();
    await t.client.query('delete from auth.users where id = $1', [owner]);
    expect(await ownersOf(id)).toEqual([]);
    const { rows } = await t.client.query<{ user_id: string }>('select user_id from conversation_members where conversation_id = $1', [id]);
    expect(rows.map((r) => r.user_id)).toEqual([member]);
  });

  it('does not apply to 1:1 conversations, which have no owner', async () => {
    const [a, b] = [await t.createUser(), await t.createUser()];
    const { conversation } = await createConversationStore(t.db).create(a, { type: 'direct', userId: b });
    await t.client.query('delete from auth.users where id = $1', [b]);
    expect(await ownersOf(conversation.id)).toEqual([]);
  });
});
