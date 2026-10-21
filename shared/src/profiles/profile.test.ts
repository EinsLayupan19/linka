import { describe, expect, it } from 'vitest';
import { createProfileSchema, profileSchema, updateProfileSchema, usernameSchema } from './profile.js';

describe('usernameSchema', () => {
  it('lowercases and trims usernames', () => {
    expect(usernameSchema.parse('  Maya_Reyes ')).toBe('maya_reyes');
  });

  it.each([
    ['ab', 'Use at least 3 characters.'],
    ['a'.repeat(21), 'Use at most 20 characters.'],
    ['maya reyes', 'Use only letters, numbers and underscores.'],
    ['maya-reyes', 'Use only letters, numbers and underscores.'],
    ['mayá', 'Use only letters, numbers and underscores.'],
  ])('rejects %j', (input, message) => {
    const result = usernameSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });
});

describe('createProfileSchema', () => {
  it('accepts a username and display name', () => {
    expect(createProfileSchema.parse({ username: 'Maya', displayName: ' Maya Reyes ' })).toEqual({
      username: 'maya',
      displayName: 'Maya Reyes',
    });
  });

  it('rejects a client-supplied id instead of silently trusting or ignoring it', () => {
    const result = createProfileSchema.safeParse({
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      username: 'maya',
      displayName: 'Maya',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty or too long display name', () => {
    expect(createProfileSchema.safeParse({ username: 'maya', displayName: '   ' }).success).toBe(false);
    expect(createProfileSchema.safeParse({ username: 'maya', displayName: 'x'.repeat(51) }).success).toBe(false);
  });
});

describe('updateProfileSchema', () => {
  it('only allows the display name to change', () => {
    expect(updateProfileSchema.safeParse({ displayName: 'Maya R.' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ displayName: 'Maya R.', username: 'other' }).success).toBe(false);
  });
});

describe('profileSchema', () => {
  it('accepts an API profile with ISO timestamps', () => {
    expect(
      profileSchema.safeParse({
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        username: 'maya',
        displayName: 'Maya',
        avatarPath: null,
        createdAt: '2026-10-21T08:00:00.000Z',
        updatedAt: '2026-10-21T08:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
