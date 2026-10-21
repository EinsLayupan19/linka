import type { MemberRole } from '@linka/shared';

/**
 * Group role rules, in one place.
 *
 * | Action                         | owner | admin            | member |
 * | ------------------------------ | ----- | ---------------- | ------ |
 * | Read, send messages            | yes   | yes              | yes    |
 * | Rename the group               | yes   | yes              | no     |
 * | Add members                    | yes   | yes              | no     |
 * | Remove a member                | yes   | regular members  | no     |
 * | Remove an admin                | yes   | no               | no     |
 * | Promote / demote, transfer     | yes   | no               | no     |
 * | Leave                          | after transferring ownership | yes | yes |
 *
 * Nobody can remove or demote the owner; ownership only moves by transfer.
 * 1:1 conversations have no roles to manage: they always have exactly two members.
 */

export function canEditGroup(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function canAddMembers(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin';
}

export type RemovalDecision = 'allowed' | 'forbidden' | 'owner_must_transfer';

export function removalDecision(actorRole: MemberRole, targetRole: MemberRole, isSelf: boolean): RemovalDecision {
  if (isSelf) return actorRole === 'owner' ? 'owner_must_transfer' : 'allowed';
  if (actorRole === 'owner') return 'allowed';
  if (actorRole === 'admin' && targetRole === 'member') return 'allowed';
  return 'forbidden';
}

/** Only the owner changes roles, and never their own (that only happens by transferring). */
export function canChangeRole(actorRole: MemberRole, isSelf: boolean): boolean {
  return actorRole === 'owner' && !isSelf;
}
