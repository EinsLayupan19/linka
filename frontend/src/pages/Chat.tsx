import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Conversation, Message, ReceiptUpdatedEvent } from '@linka/shared';
import { Composer } from '../components/chat/Composer';
import { LiveStatusNotice } from '../components/chat/LiveStatusNotice';
import { MessageList } from '../components/chat/MessageList';
import { TypingIndicator } from '../components/chat/TypingIndicator';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { useChats } from '../hooks/useChats';
import { useConversationMessages } from '../hooks/useConversationMessages';
import { useLiveConversation } from '../hooks/useLiveConversation';
import { useProfile } from '../hooks/useProfile';
import { useReadTracking } from '../hooks/useReadTracking';
import { toApiError, type ApiError } from '../lib/api';
import { getConversation } from '../services/conversations';
import { conversationTitle, otherMember } from '../utils/conversation';
import { receiptLabel, withMarkers } from '../utils/receipts';
import { formatLastSeen } from '../utils/time';

const backLinkClassName =
  'rounded-lg px-1 text-sm font-medium text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:hidden';

type DetailsState =
  | { status: 'loading' }
  | { status: 'ready'; conversation: Conversation }
  | { status: 'error'; error: ApiError };

/** One open conversation. Remounted per conversation so no state leaks between them. */
export function Chat() {
  const { conversationId = '' } = useParams();
  return <ConversationScreen key={conversationId} conversationId={conversationId} />;
}

function ConversationScreen({ conversationId }: { conversationId: string }) {
  const { profile } = useProfile();
  const { list, applyMessage, applyRead, delivery } = useChats();

  // Header details: shown from the list right away if known, then fetched fresh, and fetched
  // again whenever the conversation changes (members, roles, name).
  const fromList = list.status === 'ready' ? list.conversations.find((c) => c.id === conversationId) : undefined;
  const [details, setDetails] = useState<DetailsState>({ status: 'loading' });
  const [detailsAttempt, setDetailsAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getConversation(conversationId, controller.signal).then(
      (conversation) => setDetails({ status: 'ready', conversation }),
      (error: unknown) => {
        if (!controller.signal.aborted) setDetails({ status: 'error', error: toApiError(error) });
      },
    );
    return () => controller.abort();
  }, [conversationId, detailsAttempt]);

  const updateMembers = useCallback((event: Pick<ReceiptUpdatedEvent, 'userId' | 'lastDeliveredAt' | 'lastReadAt'>) => {
    setDetails((current) =>
      current.status === 'ready'
        ? { status: 'ready', conversation: { ...current.conversation, members: withMarkers(current.conversation.members, event) } }
        : current,
    );
  }, []);

  const onReceived = useCallback(
    (received: Message[]) => {
      // Delivery receipt for the newest message from someone else.
      const newest = received.reduce<string | null>(
        (max, m) => (m.senderId !== profile.id && (!max || m.createdAt > max) ? m.createdAt : max),
        null,
      );
      if (newest) delivery.report(conversationId, newest);
    },
    [conversationId, delivery, profile.id],
  );

  const messages = useConversationMessages(conversationId, {
    onActivity: applyMessage,
    onReceived,
    onReceipt: updateMembers,
    onConversationUpdated: () => setDetailsAttempt((n) => n + 1),
  });

  const conversation = details.status === 'ready' ? details.conversation : fromList;
  const me = conversation?.members.find((m) => m.userId === profile.id);
  const memberIds = useMemo(() => new Set(conversation?.members.map((m) => m.userId) ?? []), [conversation]);
  const live = useLiveConversation(conversationId, profile.id, memberIds, messages.state.status === 'ready');

  const [atBottom, setAtBottom] = useState(true);
  useReadTracking({
    conversationId,
    messages: messages.state.messages,
    myUserId: profile.id,
    myLastReadAt: me?.lastReadAt ?? null,
    atBottom,
    onRead: (lastReadAt) => {
      applyRead(conversationId, lastReadAt);
      updateMembers({ userId: profile.id, lastDeliveredAt: lastReadAt, lastReadAt });
    },
  });

  const senderNames = useMemo(
    () => (conversation?.type === 'group' ? new Map(conversation.members.map((m) => [m.userId, m.displayName])) : null),
    [conversation],
  );

  const notFound =
    (details.status === 'error' && details.error.code === 'CONVERSATION_NOT_FOUND') ||
    (messages.state.status === 'error' && messages.state.error?.code === 'CONVERSATION_NOT_FOUND');
  if (notFound) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">Conversation not found</h1>
          <p className="mt-1 text-sm text-ink-muted">It does not exist, or you are not a member.</p>
          <Link to="/" className="mt-4 inline-block text-sm font-medium text-accent underline-offset-4 hover:underline">
            Back to chats
          </Link>
        </div>
      </div>
    );
  }

  const title = conversation ? conversationTitle(conversation, profile.id) : '';
  const subtitle = (() => {
    if (!conversation) return '';
    if (conversation.type === 'group') {
      const online = live.onlineUserIds.length;
      return online > 0 ? `${conversation.members.length} members, ${online} online` : `${conversation.members.length} members`;
    }
    const other = otherMember(conversation, profile.id);
    if (!other) return '';
    if (live.onlineUserIds.includes(other.userId)) return 'Online';
    return other.lastSeenAt ? formatLastSeen(other.lastSeenAt) : `@${other.username}`;
  })();

  const lastMine = messages.state.messages.findLast((m) => m.senderId === profile.id);
  const receipt = conversation && lastMine ? receiptLabel(lastMine, conversation, profile.id) : null;
  const typingNames = live.typingUserIds.map(
    (id) => conversation?.members.find((m) => m.userId === id)?.displayName ?? 'Someone',
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link to="/" className={backLinkClassName}>
          Back
        </Link>
        {conversation ? (
          <>
            <Avatar
              name={title}
              size="sm"
              src={conversation.type === 'direct' ? otherMember(conversation, profile.id)?.avatarUrl : null}
            />
            <div className="min-w-0">
              <h1 className="truncate font-semibold">{title}</h1>
              {subtitle && (
                <p className={`truncate text-xs ${subtitle === 'Online' ? 'text-accent' : 'text-ink-muted'}`}>{subtitle}</p>
              )}
            </div>
          </>
        ) : (
          <span aria-hidden="true" className="block h-5 w-40 rounded-sm bg-skeleton" />
        )}
      </header>

      {messages.state.status === 'loading' && (
        <div role="status" aria-label="Loading messages" className="flex min-h-0 flex-1 flex-col justify-end gap-2 p-4">
          <span aria-hidden="true" className="block h-9 w-2/5 self-start rounded-xl bg-skeleton" />
          <span aria-hidden="true" className="block h-9 w-1/3 self-end rounded-xl bg-skeleton" />
          <span aria-hidden="true" className="block h-9 w-1/2 self-start rounded-xl bg-skeleton" />
        </div>
      )}

      {messages.state.status === 'error' && (
        <div role="alert" className="grid flex-1 place-items-center p-6 text-center">
          <div>
            <p className="font-medium">Could not load messages</p>
            <p className="mt-1 text-sm text-ink-muted">{messages.state.error?.message}</p>
            <Button variant="secondary" onClick={messages.reload} className="mt-4">
              Try again
            </Button>
          </div>
        </div>
      )}

      {messages.state.status === 'ready' && (
        <MessageList
          messages={messages.state.messages}
          pending={messages.state.pending}
          myUserId={profile.id}
          senderNames={senderNames}
          hasOlder={messages.state.nextCursor !== null}
          olderStatus={messages.state.older}
          onLoadOlder={messages.loadOlder}
          onRetry={messages.retry}
          receipt={receipt}
          onAtBottomChange={setAtBottom}
        />
      )}

      <TypingIndicator names={typingNames} />
      <LiveStatusNotice status={messages.liveStatus} />
      <Composer
        conversationId={conversationId}
        onSend={({ content, attachments }) => {
          live.stopTyping();
          messages.send(content ?? '', attachments);
        }}
        onTyping={live.notifyTyping}
        disabled={messages.state.status !== 'ready'}
      />
    </div>
  );
}
