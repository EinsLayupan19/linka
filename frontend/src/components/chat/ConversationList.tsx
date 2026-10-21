import { Link, NavLink } from 'react-router';
import type { Conversation } from '@linka/shared';
import { useChats } from '../../hooks/useChats';
import { useProfile } from '../../hooks/useProfile';
import { conversationTitle } from '../../utils/conversation';
import { formatListTimestamp } from '../../utils/time';
import { Avatar } from '../ui/Avatar';
import { Button, secondaryButtonClassName } from '../ui/Button';

function preview(conversation: Conversation, myUserId: string): string {
  const last = conversation.lastMessage;
  if (!last) return 'No messages yet';
  const text = (last.content ?? '').replace(/\s+/g, ' ').trim();
  return last.senderId === myUserId ? `You: ${text}` : text;
}

function ConversationRow({ conversation, myUserId }: { conversation: Conversation; myUserId: string }) {
  const title = conversationTitle(conversation, myUserId);
  const last = conversation.lastMessage;
  return (
    <li>
      <NavLink
        to={`/conversations/${conversation.id}`}
        className={({ isActive }) =>
          'flex items-center gap-3 rounded-lg px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ' +
          (isActive ? 'bg-surface ring-1 ring-line' : 'hover:bg-surface')
        }
      >
        <Avatar name={title} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{title}</span>
            {last && (
              <time dateTime={last.createdAt} className="shrink-0 text-xs text-ink-muted">
                {formatListTimestamp(last.createdAt)}
              </time>
            )}
          </span>
          <span className="block truncate text-sm text-ink-muted">{preview(conversation, myUserId)}</span>
        </span>
      </NavLink>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul role="status" aria-label="Loading conversations" className="grid gap-1 p-2">
      {[0, 1, 2].map((i) => (
        <li key={i} aria-hidden="true" className="flex items-center gap-3 px-3 py-2.5">
          <span className="size-10 rounded-full bg-skeleton" />
          <span className="grid flex-1 gap-2">
            <span className="block h-4 w-2/5 rounded-sm bg-skeleton" />
            <span className="block h-3.5 w-4/5 rounded-sm bg-skeleton" />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConversationList() {
  const { list, refresh } = useChats();
  const { profile } = useProfile();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Chats</h1>
        <Link to="/conversations/new" className={`${secondaryButtonClassName} h-9 px-3`}>
          New chat
        </Link>
      </div>

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto">
        {list.status === 'loading' && <ListSkeleton />}

        {list.status === 'error' && (
          <div role="alert" className="grid gap-3 p-4 text-sm">
            <p className="text-ink-muted">Could not load your conversations. {list.error.message}</p>
            <div>
              <Button variant="secondary" onClick={refresh}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {list.status === 'ready' && list.conversations.length === 0 && (
          <div className="p-4 text-sm">
            <p className="font-medium">No conversations yet</p>
            <p className="mt-1 text-ink-muted">Find someone by their username with New chat.</p>
          </div>
        )}

        {list.status === 'ready' && list.conversations.length > 0 && (
          <ul className="grid gap-0.5 p-2">
            {list.conversations.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} myUserId={profile.id} />
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}
