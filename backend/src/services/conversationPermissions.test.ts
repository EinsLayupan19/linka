import { describe, expect, it } from 'vitest';
import { canAddMembers, canChangeRole, canEditGroup, removalDecision } from './conversationPermissions.js';

describe('group permissions', () => {
  it('lets the owner and admins edit the group and add members, not regular members', () => {
    expect([canEditGroup('owner'), canEditGroup('admin'), canEditGroup('member')]).toEqual([true, true, false]);
    expect([canAddMembers('owner'), canAddMembers('admin'), canAddMembers('member')]).toEqual([true, true, false]);
  });

  it.each([
    // actor, target, expected
    ['owner', 'admin', 'allowed'],
    ['owner', 'member', 'allowed'],
    ['admin', 'member', 'allowed'],
    ['admin', 'admin', 'forbidden'],
    ['admin', 'owner', 'forbidden'],
    ['member', 'member', 'forbidden'],
    ['member', 'owner', 'forbidden'],
  ] as const)('%s removing a %s: %s', (actor, target, expected) => {
    expect(removalDecision(actor, target, false)).toBe(expected);
  });

  it('lets admins and members leave, but not the owner until ownership is transferred', () => {
    expect(removalDecision('member', 'member', true)).toBe('allowed');
    expect(removalDecision('admin', 'admin', true)).toBe('allowed');
    expect(removalDecision('owner', 'owner', true)).toBe('owner_must_transfer');
  });

  it('lets only the owner change roles, and never their own', () => {
    expect(canChangeRole('owner', false)).toBe(true);
    expect(canChangeRole('owner', true)).toBe(false);
    expect(canChangeRole('admin', false)).toBe(false);
    expect(canChangeRole('member', false)).toBe(false);
  });
});
