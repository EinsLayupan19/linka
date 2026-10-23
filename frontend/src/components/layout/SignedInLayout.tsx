import { useEffect, useState } from 'react';
import { Outlet, useMatch } from 'react-router';
import type { Conversation } from '@linka/shared';
import { CallsContext, useCallManager } from '../../hooks/useCalls';
import { ChatsContext, useConversationList } from '../../hooks/useChats';
import { useProfile } from '../../hooks/useProfile';
import { getConversation } from '../../services/conversations';
import { otherMember } from '../../utils/conversation';
import { CallPanel, type CallPeer } from '../call/CallPanel';

/**
 * Everything every signed-in page shares: the live conversation list (one user channel) and calls,
 * whose events arrive on that same channel. The call panel floats above whatever page is open.
 */
export function SignedInLayout() {
  const { profile } = useProfile();
  const openConversation = useMatch('/conversations/:conversationId')?.params.conversationId;
  const activeId = openConversation && openConversation !== 'new' ? openConversation : null;

  const calls = useCallManager(profile.id);
  const chats = useConversationList(profile.id, activeId, { onCall: calls.handleCallUpdate, onJoined: calls.resync });

  // Who the call is with: from the list, or fetched once (a brand-new conversation may not be listed yet).
  const callConversationId = 'call' in calls.state && calls.state.call ? calls.state.call.conversationId : null;
  const listed = chats.list.status === 'ready' ? chats.list.conversations.find((c) => c.id === callConversationId) : undefined;
  const [fetched, setFetched] = useState<Conversation | null>(null);
  useEffect(() => {
    if (!callConversationId || listed) return;
    const controller = new AbortController();
    getConversation(callConversationId, controller.signal).then(setFetched, () => undefined);
    return () => controller.abort();
  }, [callConversationId, listed]);
  const conversation = listed ?? (fetched?.id === callConversationId ? fetched : undefined);
  const other = conversation ? otherMember(conversation, profile.id) : undefined;
  const peer: CallPeer = { name: other?.displayName ?? 'Someone', avatarUrl: other?.avatarUrl ?? null };

  return (
    <ChatsContext.Provider value={chats}>
      <CallsContext.Provider value={calls}>
        <Outlet />
        <CallPanel calls={calls} peer={peer} />
      </CallsContext.Provider>
    </ChatsContext.Provider>
  );
}
