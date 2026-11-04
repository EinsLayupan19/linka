import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { conversationTopic, liveTopic, userTopic, type Conversation, type ConversationMember, type MemberRole, type UserSummary } from '@linka/shared';
import { App } from '../App';
import { mockApi, type ApiCall } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { CONVERSATION_ID, makeConversation, makeMessage, noMarkers, OTHER_USER_ID } from '../test/messages';
import { renderWithAuth, testProfile } from '../test/render';
import { latestChannel, realtimeChannels, TEST_USER_ID } from '../test/supabaseMock';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const PRIYA_ID = '1c3e5a7b-9d1f-4b3d-8f5a-7c9e1b3d5f7a';
const LEO_ID = '7e9a1c3e-5b7d-4f9b-8d1f-3a5c7e9b1d3f';
const NEW_GROUP_ID = '9b1d3f5a-7c9e-4b1d-9f3a-5c7e9b1d3f5a';
const groupPath = `/api/conversations/${CONVERSATION_ID}`;
const memberPath = (userId: string) => `${groupPath}/members/${userId}`;
const currentPath = () => screen.getByTestId('current-path').textContent;

const people: Record<string, UserSummary> = {
  jonas: { id: OTHER_USER_ID, username: 'jonas', displayName: 'Jonas Lindqvist', avatarUrl: null },
  priya: { id: PRIYA_ID, username: 'priya', displayName: 'Priya Sharma', avatarUrl: null },
  leo: { id: LEO_ID, username: 'leo', displayName: 'Leo Castillo', avatarUrl: null },
};

function member(user: UserSummary, role: MemberRole): ConversationMember {
  const { id, ...profile } = user;
  return { userId: id, role, joinedAt: '2026-10-22T08:00:00.000Z', ...profile, ...noMarkers };
}

/** "Weekend trip": me (Maya) with `myRole`, Jonas (the owner unless I am) and Priya. */
function makeGroup(myRole: MemberRole, overrides: Partial<Conversation> = {}): Conversation {
  return makeConversation({
    type: 'group',
    name: 'Weekend trip',
    members: [
      { ...makeConversation().members[0]!, role: myRole },
      member(people.jonas!, myRole === 'owner' ? 'member' : 'owner'),
      member(people.priya!, 'member'),
    ],
    ...overrides,
  });
}

type Handler = (call: ApiCall) => Response | Promise<Response> | undefined;

/**
 * A fake API with one stateful group: changes made through it are what the next GET returns, so
 * a refetch after an event shows them like the real API would. `on` overrides single routes.
 */
function backend(initial: Conversation | null, on: Record<string, Handler> = {}) {
  let group = initial;
  const api = mockApi((call) => {
    const override = on[`${call.method} ${call.path}`];
    if (override) return override(call);
    if (call.path === '/api/users/me') return jsonResponse(testProfile());
    if (call.path === '/api/users/me/seen') return new Response(null, { status: 204 });
    if (call.path === '/api/calls/ongoing') return jsonResponse({ calls: [] });
    if (call.method === 'GET' && call.path === '/api/conversations') return jsonResponse({ conversations: group ? [group] : [] });
    if (call.method === 'POST' && call.path === '/api/conversations/delivered') return jsonResponse({ updated: [] });
    if (call.method === 'GET' && call.path === '/api/users/search') {
      const q = call.query.get('q') ?? '';
      return jsonResponse({ users: Object.values(people).filter((p) => p.username.startsWith(q)) });
    }
    if (call.method === 'GET' && call.path.endsWith('/messages')) return jsonResponse({ messages: [], nextCursor: null });
    // Like the API for someone who is not (or no longer) a member.
    if (!group && call.path.startsWith(groupPath)) return apiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
    if (!group) return undefined;
    if (call.method === 'GET' && call.path === groupPath) return jsonResponse(group);
    if (call.method === 'PATCH' && call.path === groupPath) {
      group = { ...group, name: (call.body as { name: string }).name };
      return jsonResponse(group);
    }
    if (call.method === 'POST' && call.path === `${groupPath}/members`) {
      const ids = (call.body as { userIds: string[] }).userIds;
      group = { ...group, members: [...group.members, ...Object.values(people).filter((p) => ids.includes(p.id)).map((p) => member(p, 'member'))] };
      return jsonResponse(group);
    }
    const target = group.members.find((m) => call.path === memberPath(m.userId));
    if (call.method === 'PATCH' && target) {
      const role = (call.body as { role: MemberRole }).role;
      group = {
        ...group,
        members: group.members.map((m) =>
          m.userId === target.userId ? { ...m, role } : role === 'owner' && m.role === 'owner' ? { ...m, role: 'admin' } : m,
        ),
      };
      return jsonResponse(group);
    }
    if (call.method === 'DELETE' && target) {
      group = { ...group, members: group.members.filter((m) => m.userId !== target.userId) };
      return new Response(null, { status: 204 });
    }
    return undefined;
  });
  return { ...api, setGroup: (next: Conversation | null) => (group = next) };
}

const apiError = (status: number, code: string, message: string, fields?: Record<string, string>) =>
  jsonResponse({ error: fields ? { code, message, fields } : { code, message } }, status);

async function openGroup(myRole: MemberRole, on: Record<string, Handler> = {}) {
  const api = backend(makeGroup(myRole), on);
  renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
  await screen.findByRole('heading', { level: 1, name: 'Weekend trip' });
  return api;
}

async function openInfo(myRole: MemberRole, on: Record<string, Handler> = {}) {
  const api = await openGroup(myRole, on);
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));
  return { api, dialog: await screen.findByRole('dialog', { name: 'Group info' }) };
}

/** Types into a people picker and waits until the results include `expected` (the previous results stay until then). */
async function search(label: string, query: string, expected: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value: query } });
  await waitFor(() =>
    expect(within(screen.getByRole('list', { name: 'Search results' })).getByRole('button', { name: new RegExp(expected) })).toBeInTheDocument(),
  );
  return screen.getByRole('list', { name: 'Search results' });
}

async function choose(label: string, query: string, name: string) {
  const results = await search(label, query, name);
  fireEvent.click(within(results).getByRole('button', { name: new RegExp(name) }));
}

const memberList = (dialog: HTMLElement) => within(within(dialog).getByRole('region', { name: 'Members' })).getAllByRole('listitem');

describe('creating a group', () => {
  it('names the group, chooses people, creates it and opens it', async () => {
    const api = backend(null, {
      'POST /api/conversations': (call) => {
        const { name, memberIds } = call.body as { name: string; memberIds: string[] };
        api.setGroup(
          makeConversation({
            id: NEW_GROUP_ID,
            type: 'group',
            name,
            members: [{ ...makeConversation().members[0]!, role: 'owner' }, ...memberIds.map((id) => member(Object.values(people).find((p) => p.id === id)!, 'member'))],
          }),
        );
        return jsonResponse(makeConversation({ id: NEW_GROUP_ID, type: 'group', name, members: [{ ...makeConversation().members[0]!, role: 'owner' }] }), 201);
      },
    });
    renderWithAuth(<App />, { path: '/conversations/new' });
    fireEvent.click(await screen.findByRole('link', { name: 'New group' }));

    fireEvent.change(await screen.findByLabelText('Group name'), { target: { value: 'Weekend trip' } });
    await choose('Members', 'pr', 'Priya Sharma');
    await choose('Members', 'jo', 'Jonas Lindqvist');
    expect(within(screen.getByRole('list', { name: 'Chosen people' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove Priya Sharma',
      'Remove Jonas Lindqvist',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(currentPath()).toBe(`/conversations/${NEW_GROUP_ID}`));
    expect(api.callsTo('POST', '/api/conversations')[0]!.body).toEqual({ type: 'group', name: 'Weekend trip', memberIds: [PRIYA_ID, OTHER_USER_ID] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekend trip' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Conversations' })).getByText('Weekend trip')).toBeInTheDocument();
  });

  it('needs a name and at least one other person, and says so without calling the API', async () => {
    const api = backend(null);
    renderWithAuth(<App />, { path: '/conversations/new/group' });
    fireEvent.click(await screen.findByRole('button', { name: 'Create group' }));

    expect(await screen.findByText('Enter a group name.')).toBeInTheDocument();
    expect(screen.getByText('Add at least one member.')).toBeInTheDocument();
    expect(screen.getByLabelText('Group name')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByText('Enter a group name.')).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/conversations')).toEqual([]);
  });

  it('cannot choose the same person twice: choosing again takes them out', async () => {
    const api = backend(null, { 'POST /api/conversations': () => apiError(503, 'SERVICE_UNAVAILABLE', 'Try again shortly.') });
    renderWithAuth(<App />, { path: '/conversations/new/group' });
    fireEvent.change(await screen.findByLabelText('Group name'), { target: { value: 'Trip' } });

    await choose('Members', 'pr', 'Priya Sharma');
    const priya = () => within(screen.getByRole('list', { name: 'Search results' })).getByRole('button', { name: /Priya Sharma/ });
    expect(priya()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(priya());
    expect(priya()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('list', { name: 'Chosen people' })).not.toBeInTheDocument();

    fireEvent.click(priya());
    // Searching again shows her as chosen; she is still listed once.
    await search('Members', 'pri', 'Priya Sharma');
    expect(priya()).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('list', { name: 'Chosen people' })).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(api.callsTo('POST', '/api/conversations')).toHaveLength(1));
    expect(api.callsTo('POST', '/api/conversations')[0]!.body).toMatchObject({ memberIds: [PRIYA_ID] });
  });

  it('shows "Creating…" while it works, then the server’s reason, and keeps the form', async () => {
    let answer!: (response: Response) => void;
    backend(null, { 'POST /api/conversations': () => new Promise<Response>((resolve) => (answer = resolve)) });
    renderWithAuth(<App />, { path: '/conversations/new/group' });
    fireEvent.change(await screen.findByLabelText('Group name'), { target: { value: 'Trip' } });
    await choose('Members', 'le', 'Leo Castillo');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
    await act(async () => answer(apiError(400, 'VALIDATION_FAILED', 'That user does not exist.', { memberIds: 'That user does not exist.' })));

    expect(await screen.findByText('That user does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group' })).toBeEnabled();
    expect(screen.getByLabelText('Group name')).toHaveValue('Trip');
    expect(currentPath()).toBe('/conversations/new/group');
  });

  it('shows a general error when the server cannot be reached', async () => {
    backend(null, { 'POST /api/conversations': () => Promise.reject(new TypeError('Failed to fetch')) });
    renderWithAuth(<App />, { path: '/conversations/new/group' });
    fireEvent.change(await screen.findByLabelText('Group name'), { target: { value: 'Trip' } });
    await choose('Members', 'le', 'Leo Castillo');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });
});

describe('group conversations', () => {
  it('appear in the list with their name, who wrote the last message, time and unread count', async () => {
    const last = makeMessage({ senderId: OTHER_USER_ID, content: 'See you there' });
    backend(makeGroup('member', { lastMessage: last, unreadCount: 2 }));
    renderWithAuth(<App />, { path: '/' });

    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    const row = (await within(nav).findByText('Weekend trip')).closest('a')!;
    expect(row).toHaveTextContent('Group:');
    expect(within(row).getByText('Jonas Lindqvist: See you there')).toBeInTheDocument();
    expect(within(row).getByText('2 unread')).toBeInTheDocument();
    expect(row.querySelector('time')).toHaveAttribute('dateTime', last.createdAt);
  });

  it('open with the group name, member count and group info, and no call buttons', async () => {
    await openGroup('member');
    const header = screen.getByRole('heading', { level: 1, name: 'Weekend trip' }).closest('header')!;
    expect(within(header).getByText('3 members')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Group info' })).toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: /call/i })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });
});

describe('group info', () => {
  it('shows the members with their roles and your own role; a member can only leave', async () => {
    const { dialog } = await openInfo('member');

    expect(within(dialog).getByRole('heading', { name: 'Weekend trip' })).toBeInTheDocument();
    expect(within(dialog).getByText('3 members')).toBeInTheDocument();
    expect(within(dialog).getByText('You are a member')).toBeInTheDocument();
    const rows = memberList(dialog);
    expect(rows.map((row) => row.textContent)).toEqual(['JJonas Lindqvist@jonasOwner', 'MMaya Reyes (you)@maya', 'PPriya Sharma@priya']);
    expect(within(dialog).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Manage/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Leave group' })).toBeEnabled();
  });

  it('an admin can rename and add people, and manage regular members but not the owner', async () => {
    const { dialog } = await openInfo('admin');

    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add people' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: /^Manage/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Manage Priya Sharma']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Manage Priya Sharma' }));
    expect(await within(dialog).findByRole('button', { name: 'Remove from group' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Make admin' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Make owner' })).not.toBeInTheDocument();
  });

  it('the owner can manage everyone, but must hand over ownership before leaving', async () => {
    const { dialog } = await openInfo('owner');

    expect(within(dialog).getAllByRole('button', { name: /^Manage/ })).toHaveLength(2);
    const leave = within(dialog).getByRole('button', { name: 'Leave group' });
    // Unavailable but still focusable, so its explanation can be reached with a keyboard.
    expect(leave).toHaveAttribute('aria-disabled', 'true');
    expect(leave).toHaveAccessibleDescription('As the owner, make someone else the owner before you leave.');
    leave.focus();
    expect(leave).toHaveFocus();
    fireEvent.click(leave);
    expect(within(dialog).queryByRole('heading', { name: /^Leave / })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Manage Jonas Lindqvist' }));
    for (const name of ['Make admin', 'Make owner', 'Remove from group']) {
      expect(await within(dialog).findByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('renames the group: the dialog, the header and the list show the new name', async () => {
    const { api, dialog } = await openInfo('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    const field = await within(dialog).findByLabelText('Group name');
    expect(field).toHaveValue('Weekend trip');

    fireEvent.change(field, { target: { value: 'Lake weekend' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('heading', { name: 'Lake weekend' })).toBeInTheDocument();
    expect(api.callsTo('PATCH', groupPath)[0]!.body).toEqual({ name: 'Lake weekend' });
    expect(screen.getByRole('heading', { level: 1, name: 'Lake weekend' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Conversations' })).getByText('Lake weekend')).toBeInTheDocument();
  });

  it('checks the new name before sending it', async () => {
    const { api, dialog } = await openInfo('admin');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    fireEvent.change(await within(dialog).findByLabelText('Group name'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Enter a group name.')).toBeInTheDocument();
    expect(api.callsTo('PATCH', groupPath)).toEqual([]);
  });

  it('shows the API’s refusal when renaming is not allowed (for example a role changed meanwhile)', async () => {
    const { dialog } = await openInfo('admin', {
      [`PATCH ${groupPath}`]: () => apiError(403, 'FORBIDDEN', 'Only the owner and admins can change the group.'),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    fireEvent.change(await within(dialog).findByLabelText('Group name'), { target: { value: 'Mine now' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only the owner and admins can change the group.');
    expect(within(dialog).getByLabelText('Group name')).toHaveValue('Mine now');
  });

  it('adds people; people already in the group cannot be chosen', async () => {
    const { api, dialog } = await openInfo('admin');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add people' }));

    const results = await search('People to add', 'pr', 'Priya Sharma');
    const priya = within(results).getByRole('button', { name: /Priya Sharma/ });
    expect(priya).toBeDisabled();
    expect(priya).toHaveTextContent('Already in the group');

    await choose('People to add', 'le', 'Leo Castillo');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 person' }));

    expect(await within(dialog).findByText('4 members')).toBeInTheDocument();
    expect(api.callsTo('POST', `${groupPath}/members`)[0]!.body).toEqual({ userIds: [LEO_ID] });
    expect(memberList(dialog).some((row) => row.textContent?.includes('Leo Castillo'))).toBe(true);
    expect(screen.getByRole('heading', { level: 1, name: 'Weekend trip' }).closest('header')).toHaveTextContent('4 members');
  });

  it('needs at least one person to add, and shows the API’s answer if someone was added meanwhile', async () => {
    const { api, dialog } = await openInfo('owner', {
      [`POST ${groupPath}/members`]: () => apiError(409, 'ALREADY_MEMBER', 'Some of these people are already in the group.'),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add people' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('Choose at least one person.')).toBeInTheDocument();
    expect(api.callsTo('POST', `${groupPath}/members`)).toEqual([]);

    await choose('People to add', 'le', 'Leo Castillo');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 person' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Some of these people are already in the group.');
  });

  it('removes a member only after confirming; Cancel changes nothing', async () => {
    const { api, dialog } = await openInfo('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Manage Priya Sharma' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove from group' }));

    expect(await within(dialog).findByRole('heading', { name: 'Remove Priya Sharma?' })).toHaveFocus();
    expect(within(dialog).getByText(/lose access to its messages and files/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await within(dialog).findByRole('button', { name: 'Remove from group' })).toBeInTheDocument();
    expect(api.callsTo('DELETE', memberPath(PRIYA_ID))).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from group' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove' }));

    expect(await within(dialog).findByText('2 members')).toBeInTheDocument();
    expect(api.callsTo('DELETE', memberPath(PRIYA_ID))).toHaveLength(1);
    expect(memberList(dialog).some((row) => row.textContent?.includes('Priya'))).toBe(false);
  });

  it('shows the API’s refusal when a removal is not allowed, and keeps the member', async () => {
    const { dialog } = await openInfo('admin', {
      [`DELETE ${memberPath(PRIYA_ID)}`]: () => apiError(403, 'FORBIDDEN', 'You cannot remove this member.'),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Manage Priya Sharma' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove from group' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You cannot remove this member.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Back' }));
    expect(await within(dialog).findByText('3 members')).toBeInTheDocument();
  });

  it('transfers ownership after explaining what changes; the old owner becomes an admin', async () => {
    const { api, dialog } = await openInfo('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Manage Jonas Lindqvist' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Make owner' }));

    expect(await within(dialog).findByText(/You will become an admin/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make owner' }));

    expect(await within(dialog).findByText('You are an admin')).toBeInTheDocument();
    expect(api.callsTo('PATCH', memberPath(OTHER_USER_ID))[0]!.body).toEqual({ role: 'owner' });
    expect(memberList(dialog)[0]).toHaveTextContent('Jonas Lindqvist@jonasOwner');
    // Now an admin: no longer allowed to change Jonas.
    expect(within(dialog).queryByRole('button', { name: /Manage Jonas/ })).not.toBeInTheDocument();
  });

  it('the owner can make a member an admin and back', async () => {
    const { api, dialog } = await openInfo('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Manage Priya Sharma' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Make admin' }));
    expect(await within(dialog).findByRole('button', { name: 'Remove as admin' })).toBeInTheDocument();
    expect(api.callsTo('PATCH', memberPath(PRIYA_ID)).map((c) => c.body)).toEqual([{ role: 'admin' }]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove as admin' }));
    expect(await within(dialog).findByRole('button', { name: 'Make admin' })).toBeInTheDocument();
    expect(api.callsTo('PATCH', memberPath(PRIYA_ID)).map((c) => c.body)).toEqual([{ role: 'admin' }, { role: 'member' }]);
  });

  it('leaves the group after confirming, and goes back to the list without it', async () => {
    const { api, dialog } = await openInfo('member');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));
    expect(await within(dialog).findByRole('heading', { name: 'Leave Weekend trip?' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));

    await waitFor(() => expect(currentPath()).toBe('/'));
    expect(api.callsTo('DELETE', memberPath(TEST_USER_ID))).toHaveLength(1);
    expect(within(screen.getByRole('navigation', { name: 'Conversations' })).queryByText('Weekend trip')).not.toBeInTheDocument();
  });

  it('closes with the Close button and opens fresh again', async () => {
    const { dialog } = await openInfo('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Group info' }));
    const again = await screen.findByRole('dialog', { name: 'Group info' });
    expect(within(again).getByRole('heading', { name: 'Weekend trip' })).toBeInTheDocument();
  });
});

describe('live group changes', () => {
  async function joinConversationChannel() {
    const topic = conversationTopic(CONVERSATION_ID, 0);
    await waitFor(() => expect(realtimeChannels.some((c) => c.topic === topic)).toBe(true));
    await act(async () => {
      await Promise.resolve();
      latestChannel(topic).join();
    });
    return latestChannel(topic);
  }

  it('shows a rename or new member made by someone else, from the conversation channel', async () => {
    const api = await openGroup('member');
    const channel = await joinConversationChannel();
    fireEvent.click(screen.getByRole('button', { name: 'Group info' }));
    const dialog = await screen.findByRole('dialog', { name: 'Group info' });

    api.setGroup({ ...makeGroup('member'), name: 'Lake weekend', members: [...makeGroup('member').members, member(people.leo!, 'member')] });
    act(() => channel.emit('conversation.updated', { conversationId: CONVERSATION_ID }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Lake weekend' })).toBeInTheDocument();
    expect(within(dialog).getByText('4 members')).toBeInTheDocument();
  });

  it('after someone leaves, moves to the group’s new channels and keeps receiving messages there', async () => {
    const api = await openGroup('member');
    const oldChannel = await joinConversationChannel();
    await waitFor(() => expect(realtimeChannels.some((c) => c.topic === liveTopic(CONVERSATION_ID, 0))).toBe(true));

    // Priya leaves: the database moves the group to channel version 1 and says so on the old channel.
    const after = makeGroup('member', { channelVersion: 1 });
    api.setGroup({ ...after, members: after.members.filter((m) => m.userId !== PRIYA_ID) });
    act(() => oldChannel.emit('conversation.updated', { conversationId: CONVERSATION_ID }));

    await waitFor(() => expect(realtimeChannels.some((c) => c.topic === conversationTopic(CONVERSATION_ID, 1))).toBe(true));
    expect(oldChannel.removed).toBe(true);
    expect(latestChannel(liveTopic(CONVERSATION_ID, 0)).removed).toBe(true);
    await waitFor(() => expect(realtimeChannels.some((c) => c.topic === liveTopic(CONVERSATION_ID, 1) && !c.removed)).toBe(true));
    expect(screen.getByRole('heading', { level: 1, name: 'Weekend trip' }).closest('header')).toHaveTextContent('2 members');

    const newChannel = latestChannel(conversationTopic(CONVERSATION_ID, 1));
    await act(async () => newChannel.join());
    act(() => newChannel.emit('message.created', makeMessage({ content: 'Still here' })));
    expect(await within(screen.getByRole('log', { name: 'Messages' })).findByText('Still here')).toBeInTheDocument();
  });

  it('when someone removes you, the group disappears from your list and can no longer be opened', async () => {
    const api = await openGroup('member');
    const channel = await joinConversationChannel();
    await waitFor(() => expect(realtimeChannels.some((c) => c.topic === userTopic(TEST_USER_ID))).toBe(true));

    api.setGroup(null); // the API now answers 404 for this group
    act(() => latestChannel(userTopic(TEST_USER_ID)).emit('conversation.changed', { conversationId: CONVERSATION_ID, change: 'removed' }));
    act(() => channel.emit('conversation.updated', { conversationId: CONVERSATION_ID }));

    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Conversations' })).queryByText('Weekend trip')).not.toBeInTheDocument();
  });
});
