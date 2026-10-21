import { describe, expect, it } from 'vitest';
import { createMessageSchema } from '../messages/message.js';
import { userSearchQuerySchema } from '../profiles/profile.js';
import { addMembersSchema, createConversationSchema, updateMemberRoleSchema } from './conversation.js';

const maya = '0f8fad5b-d9cb-469f-a165-70867728950e';
const jonas = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('createConversationSchema', () => {
  it('accepts a 1:1 conversation with one other user', () => {
    expect(createConversationSchema.parse({ type: 'direct', userId: maya })).toEqual({ type: 'direct', userId: maya });
  });

  it('accepts a named group with members', () => {
    expect(createConversationSchema.parse({ type: 'group', name: '  Weekend trip ', memberIds: [maya, jonas] })).toEqual(
      { type: 'group', name: 'Weekend trip', memberIds: [maya, jonas] },
    );
  });

  it('rejects unknown conversation types', () => {
    expect(createConversationSchema.safeParse({ type: 'channel', userId: maya }).success).toBe(false);
  });

  it('rejects a 1:1 conversation with a list of members', () => {
    expect(createConversationSchema.safeParse({ type: 'direct', memberIds: [maya, jonas] }).success).toBe(false);
  });

  it('rejects a client-supplied creator or owner', () => {
    expect(
      createConversationSchema.safeParse({ type: 'group', name: 'G', memberIds: [maya], createdBy: jonas }).success,
    ).toBe(false);
  });

  it('requires a group name and at least one other member', () => {
    expect(createConversationSchema.safeParse({ type: 'group', name: ' ', memberIds: [maya] }).success).toBe(false);
    expect(createConversationSchema.safeParse({ type: 'group', name: 'G', memberIds: [] }).success).toBe(false);
  });

  it('rejects ids that are not UUIDs', () => {
    expect(createConversationSchema.safeParse({ type: 'direct', userId: '42' }).success).toBe(false);
  });

  it('caps the group size', () => {
    const tooMany = Array.from({ length: 100 }, () => maya);
    expect(createConversationSchema.safeParse({ type: 'group', name: 'Big', memberIds: tooMany }).success).toBe(false);
  });
});

describe('member schemas', () => {
  it('accepts known roles only', () => {
    expect(updateMemberRoleSchema.safeParse({ role: 'admin' }).success).toBe(true);
    expect(updateMemberRoleSchema.safeParse({ role: 'superuser' }).success).toBe(false);
  });

  it('requires at least one user to add', () => {
    expect(addMembersSchema.safeParse({ userIds: [] }).success).toBe(false);
  });
});

describe('createMessageSchema', () => {
  const clientId = '9b2d4f6a-8c0e-4a1b-9d3f-5e7a9c1b3d5f';

  it('keeps the content exactly as typed', () => {
    expect(createMessageSchema.parse({ content: '  indented\nsecond line ', clientId })).toEqual({
      content: '  indented\nsecond line ',
      clientId,
    });
  });

  it('rejects empty, whitespace-only and oversized messages', () => {
    expect(createMessageSchema.safeParse({ content: '', clientId }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: ' \n\t ', clientId }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: 'x'.repeat(4001), clientId }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: 'x'.repeat(4000), clientId }).success).toBe(true);
  });

  it('rejects a client-supplied sender', () => {
    expect(createMessageSchema.safeParse({ content: 'hi', clientId, senderId: maya }).success).toBe(false);
  });

  it('requires a UUID client id', () => {
    expect(createMessageSchema.safeParse({ content: 'hi' }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: 'hi', clientId: 'abc' }).success).toBe(false);
  });
});

describe('userSearchQuerySchema', () => {
  it('lowercases and trims the query', () => {
    expect(userSearchQuerySchema.parse({ q: '  MaYa ' })).toEqual({ q: 'maya' });
  });

  it('requires at least 2 characters', () => {
    expect(userSearchQuerySchema.safeParse({ q: 'm' }).success).toBe(false);
    expect(userSearchQuerySchema.safeParse({}).success).toBe(false);
  });
});
