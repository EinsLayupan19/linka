import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  addMembersSchema,
  canAddMembers,
  canChangeRole,
  canEditGroup,
  CONVERSATION_NAME_MAX_LENGTH,
  removalDecision,
  updateConversationSchema,
  type Conversation,
  type ConversationMember,
  type MemberRole,
  type UserSummary,
} from '@linka/shared';
import { toApiError } from '../../lib/api';
import { addGroupMembers, removeGroupMember, renameGroup, setMemberRole } from '../../services/conversations';
import { fieldErrors } from '../../utils/formErrors';
import { ConversationAvatar } from '../chat/ConversationAvatar';
import { PeoplePicker } from '../people/PeoplePicker';
import { Alert } from '../ui/Alert';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { TextField } from '../ui/TextField';

type View =
  | { name: 'overview' }
  | { name: 'rename' }
  | { name: 'add' }
  | { name: 'member'; userId: string }
  | { name: 'remove' | 'transfer'; userId: string }
  | { name: 'leave' };

const roleLabel: Record<MemberRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const yourRole: Record<MemberRole, string> = { owner: 'You are the owner', admin: 'You are an admin', member: 'You are a member' };
const roleOrder: Record<MemberRole, number> = { owner: 0, admin: 1, member: 2 };

/** A destructive entry point that is not itself the final step: outlined, in the danger color. */
const dangerOutline = 'text-danger hover:border-danger';

interface GroupInfoDialogProps {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
  myUserId: string;
  /** The API returned the changed group (or a member was removed): show it everywhere. */
  onUpdated: (conversation: Conversation) => void;
  /** The user left the group. */
  onLeft: () => void;
}

/**
 * Group details and management. Every action is offered only when the user's role allows it,
 * using the same rules the API enforces (@linka/shared permissions); the API still decides, and
 * its answer (for example "only the owner can change roles") is shown when it refuses.
 */
export function GroupInfoDialog({ open, onClose, ...props }: GroupInfoDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Group info">
      <GroupInfo {...props} />
    </Dialog>
  );
}

function GroupInfo({ conversation, myUserId, onUpdated, onLeft }: Omit<GroupInfoDialogProps, 'open' | 'onClose'>) {
  const [view, setView] = useState<View>({ name: 'overview' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerHintId = useId();

  // Move focus to the new view's heading when the view changes (not on first open: the dialog
  // focuses its first control then), so keyboard and screen-reader users land in the right place.
  const container = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    container.current?.querySelector<HTMLElement>('[data-view-heading]')?.focus();
  }, [view]);

  const me = conversation.members.find((m) => m.userId === myUserId);
  if (!me) return null; // the API only returns groups the user belongs to
  const groupName = conversation.name ?? 'Group';
  const memberCount = conversation.members.length;

  const go = (next: View) => {
    setError(null);
    setView(next);
  };

  /** Runs one API action; on success optionally switches view, on failure shows why. */
  async function run(action: () => Promise<void>, next: View | null) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (next) setView(next);
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      setBusy(false);
    }
  }

  // A view about someone who is no longer in the group (removed by someone else meanwhile).
  const target = 'userId' in view ? conversation.members.find((m) => m.userId === view.userId) : undefined;
  const current: View = 'userId' in view && !target ? { name: 'overview' } : view;

  const errorAlert = error && <Alert tone="danger">{error}</Alert>;

  let content: ReactNode;
  switch (current.name) {
    case 'overview': {
      const sorted = [...conversation.members].sort(
        (a, b) => roleOrder[a.role] - roleOrder[b.role] || a.displayName.localeCompare(b.displayName),
      );
      content = (
        <div className="grid gap-5">
          <div className="flex items-center gap-4">
            <ConversationAvatar conversation={conversation} myUserId={myUserId} size="lg" ring="surface" />
            <div className="min-w-0">
              <h3 data-view-heading tabIndex={-1} className="truncate text-lg font-semibold focus:outline-none">
                {groupName}
              </h3>
              <p className="text-sm text-ink-muted">
                {memberCount} {memberCount === 1 ? 'member' : 'members'}
              </p>
              <p className="text-sm text-ink-muted">{yourRole[me.role]}</p>
            </div>
          </div>

          {(canEditGroup(me.role) || canAddMembers(me.role)) && (
            <div className="flex flex-wrap gap-2">
              {canEditGroup(me.role) && (
                <Button variant="secondary" onClick={() => go({ name: 'rename' })} className="h-9 px-3">
                  Rename
                </Button>
              )}
              {canAddMembers(me.role) && (
                <Button variant="secondary" onClick={() => go({ name: 'add' })} className="h-9 px-3">
                  Add people
                </Button>
              )}
            </div>
          )}

          {errorAlert}

          <section aria-label="Members">
            <h4 className="text-sm font-medium text-ink-muted">Members</h4>
            <ul className="mt-2 grid gap-0.5">
              {sorted.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  isMe={member.userId === myUserId}
                  manageable={member.userId !== myUserId && hasActionsFor(me.role, member.role)}
                  onManage={() => go({ name: 'member', userId: member.userId })}
                />
              ))}
            </ul>
          </section>

          <div className="border-t border-line pt-4">
            {/* For the owner, aria-disabled rather than disabled: it stays focusable, so keyboard
                and screen-reader users reach it and hear why they cannot leave yet. */}
            <Button
              variant="secondary"
              onClick={me.role === 'owner' ? undefined : () => go({ name: 'leave' })}
              aria-disabled={me.role === 'owner' || undefined}
              aria-describedby={me.role === 'owner' ? ownerHintId : undefined}
              className={`h-9 px-3 ${dangerOutline} aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-line`}
            >
              Leave group
            </Button>
            {me.role === 'owner' && (
              <p id={ownerHintId} className="mt-2 text-sm text-ink-muted">
                {memberCount > 1
                  ? 'As the owner, make someone else the owner before you leave.'
                  : 'You are the only member left, so you cannot leave this group.'}
              </p>
            )}
          </div>
        </div>
      );
      break;
    }

    case 'member': {
      const member = target!;
      const changesRoles = canChangeRole(me.role, false);
      content = (
        <div className="grid gap-5">
          <BackButton onClick={() => go({ name: 'overview' })} />
          <div className="flex items-center gap-3">
            <Avatar name={member.displayName} src={member.avatarUrl} />
            <div className="min-w-0">
              <h3 data-view-heading tabIndex={-1} className="truncate font-semibold focus:outline-none">
                {member.displayName}
              </h3>
              <p className="truncate text-sm text-ink-muted">
                @{member.username}, {roleLabel[member.role].toLowerCase()}
              </p>
            </div>
          </div>
          {errorAlert}
          <div className="grid gap-2 sm:justify-items-start">
            {changesRoles && member.role !== 'owner' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    onUpdated(await setMemberRole(conversation.id, member.userId, member.role === 'admin' ? 'member' : 'admin'));
                  }, null)
                }
              >
                {member.role === 'admin' ? 'Remove as admin' : 'Make admin'}
              </Button>
            )}
            {changesRoles && member.role !== 'owner' && (
              <Button variant="secondary" disabled={busy} onClick={() => go({ name: 'transfer', userId: member.userId })}>
                Make owner
              </Button>
            )}
            {removalDecision(me.role, member.role, false) === 'allowed' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => go({ name: 'remove', userId: member.userId })}
                className={dangerOutline}
              >
                Remove from group
              </Button>
            )}
          </div>
        </div>
      );
      break;
    }

    case 'remove':
    case 'transfer':
    case 'leave': {
      const name = target?.displayName ?? '';
      const copy = {
        remove: {
          title: `Remove ${name}?`,
          body: `${name} will leave ${groupName} and lose access to its messages and files. They can only come back if someone adds them again.`,
          confirm: 'Remove',
          pending: 'Removing…',
          variant: 'danger' as const,
          action: async () => {
            await removeGroupMember(conversation.id, target!.userId);
            onUpdated({ ...conversation, members: conversation.members.filter((m) => m.userId !== target!.userId) });
          },
        },
        transfer: {
          title: `Make ${name} the owner?`,
          body: `${name} will be able to change everyone’s roles and remove admins. You will become an admin, and only ${name} can make you the owner again.`,
          confirm: 'Make owner',
          pending: 'Transferring…',
          variant: 'primary' as const,
          action: async () => onUpdated(await setMemberRole(conversation.id, target!.userId, 'owner')),
        },
        leave: {
          title: `Leave ${groupName}?`,
          body: 'You will no longer see this group or its messages. To come back, the owner or an admin has to add you again.',
          confirm: 'Leave group',
          pending: 'Leaving…',
          variant: 'danger' as const,
          action: async () => {
            await removeGroupMember(conversation.id, myUserId);
            onLeft();
          },
        },
      }[current.name];
      const back: View = current.name === 'leave' ? { name: 'overview' } : { name: 'member', userId: target!.userId };
      content = (
        <div className="grid gap-4">
          <h3 data-view-heading tabIndex={-1} className="font-semibold focus:outline-none">
            {copy.title}
          </h3>
          <p className="text-sm text-ink-muted">{copy.body}</p>
          {errorAlert}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => go(back)}>
              Cancel
            </Button>
            <Button
              variant={copy.variant}
              disabled={busy}
              onClick={() => run(copy.action, current.name === 'leave' ? null : { name: 'overview' })}
            >
              {busy ? copy.pending : copy.confirm}
            </Button>
          </div>
        </div>
      );
      break;
    }

    case 'rename':
      content = (
        <RenameForm
          initialName={conversation.name ?? ''}
          busy={busy}
          error={error}
          onCancel={() => go({ name: 'overview' })}
          onSubmit={(name) =>
            run(async () => onUpdated(await renameGroup(conversation.id, name)), { name: 'overview' })
          }
        />
      );
      break;

    case 'add':
      content = (
        <AddPeopleForm
          memberIds={new Set(conversation.members.map((m) => m.userId))}
          busy={busy}
          error={error}
          onCancel={() => go({ name: 'overview' })}
          onSubmit={(userIds) =>
            run(async () => onUpdated(await addGroupMembers(conversation.id, userIds)), { name: 'overview' })
          }
        />
      );
      break;
  }

  return <div ref={container}>{content}</div>;
}

/** Whether someone with `myRole` can do anything to a member with `role` (other than themselves). */
function hasActionsFor(myRole: MemberRole, role: MemberRole): boolean {
  return (canChangeRole(myRole, false) && role !== 'owner') || removalDecision(myRole, role, false) === 'allowed';
}

function MemberRow({
  member,
  isMe,
  manageable,
  onManage,
}: {
  member: ConversationMember;
  isMe: boolean;
  manageable: boolean;
  onManage: () => void;
}) {
  const body = (
    <>
      <Avatar name={member.displayName} src={member.avatarUrl} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {member.displayName}
          {isMe && <span className="font-normal text-ink-muted"> (you)</span>}
        </span>
        <span className="block truncate text-xs text-ink-muted">@{member.username}</span>
      </span>
      {member.role !== 'member' && <span className="shrink-0 text-xs font-medium text-ink-muted">{roleLabel[member.role]}</span>}
      {manageable && (
        <span aria-hidden="true" className="shrink-0 text-ink-muted">
          ›
        </span>
      )}
    </>
  );
  const rowClassName = 'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left';
  return (
    <li>
      {manageable ? (
        <button
          type="button"
          onClick={onManage}
          aria-label={`Manage ${member.displayName}${member.role === 'member' ? '' : `, ${roleLabel[member.role].toLowerCase()}`}`}
          className={`${rowClassName} hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent`}
        >
          {body}
        </button>
      ) : (
        <div className={rowClassName}>{body}</div>
      )}
    </li>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="secondary" onClick={onClick} className="h-8 justify-self-start px-3">
      Back
    </Button>
  );
}

function RenameForm({
  initialName,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [fieldError, setFieldError] = useState<string | undefined>();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = updateConversationSchema.safeParse({ name });
    if (!parsed.success) {
      setFieldError(fieldErrors(parsed.error).name);
      return;
    }
    setFieldError(undefined);
    onSubmit(parsed.data.name);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="grid gap-4">
      <h3 data-view-heading tabIndex={-1} className="font-semibold focus:outline-none">
        Rename group
      </h3>
      {error && <Alert tone="danger">{error}</Alert>}
      <TextField
        label="Group name"
        autoComplete="off"
        maxLength={CONVERSATION_NAME_MAX_LENGTH}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        error={fieldError}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

function AddPeopleForm({
  memberIds,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  memberIds: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (userIds: string[]) => void;
}) {
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [fieldError, setFieldError] = useState<string | undefined>();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = addMembersSchema.safeParse({ userIds: people.map((p) => p.id) });
    if (!parsed.success) {
      setFieldError(fieldErrors(parsed.error).userIds);
      return;
    }
    setFieldError(undefined);
    onSubmit(parsed.data.userIds);
  }

  const count = people.length;
  return (
    <form noValidate onSubmit={handleSubmit} className="grid gap-4">
      <h3 data-view-heading tabIndex={-1} className="font-semibold focus:outline-none">
        Add people
      </h3>
      {error && <Alert tone="danger">{error}</Alert>}
      <PeoplePicker
        label="People to add"
        selected={people}
        onChange={(next) => {
          setPeople(next);
          setFieldError(undefined);
        }}
        excludeIds={memberIds}
        disabled={busy}
        error={fieldError}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Adding…' : count > 0 ? `Add ${count} ${count === 1 ? 'person' : 'people'}` : 'Add'}
        </Button>
      </div>
    </form>
  );
}
