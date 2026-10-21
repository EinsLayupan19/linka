import { Outlet, useMatch } from 'react-router';
import { ConversationList } from '../components/chat/ConversationList';
import { ChatsContext, useConversationList } from '../hooks/useChats';

/**
 * Chat layout. Desktop: conversation list beside the open conversation.
 * Mobile: one at a time, the list at "/", a conversation full-screen at /conversations/...
 */
export function Chats() {
  const chats = useConversationList();
  const inConversation = useMatch('/conversations/*') !== null;

  return (
    <ChatsContext.Provider value={chats}>
      {/* Fills the viewport under the 3.5rem header (+1px border); panes scroll internally. */}
      <div className="mx-auto grid h-[calc(100dvh-3.5rem-1px)] w-full max-w-6xl md:grid-cols-[20rem_1fr] md:border-x md:border-line">
        <aside className={`${inConversation ? 'hidden md:flex' : 'flex'} min-h-0 flex-col md:border-r md:border-line`}>
          <ConversationList />
        </aside>
        <section className={`${inConversation ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-col`}>
          <Outlet />
        </section>
      </div>
    </ChatsContext.Provider>
  );
}

/** Desktop right pane when no conversation is open. */
export function ChatsHome() {
  return (
    <div className="grid flex-1 place-items-center p-6 text-center">
      <div>
        <p className="font-medium">Select a conversation</p>
        <p className="mt-1 text-sm text-ink-muted">Or start a new one with New chat.</p>
      </div>
    </div>
  );
}
