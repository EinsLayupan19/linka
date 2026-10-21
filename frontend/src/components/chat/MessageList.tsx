import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Message } from '@linka/shared';
import type { PendingMessage } from '../../hooks/conversationMessagesReducer';
import { formatDayLabel, formatFullTimestamp, formatMessageTime, isSameDay } from '../../utils/time';
import { Button } from '../ui/Button';

interface MessageListProps {
  messages: Message[];
  pending: PendingMessage[];
  myUserId: string;
  /** Names to show above other people's messages in groups. */
  senderNames: Map<string, string> | null;
  hasOlder: boolean;
  olderStatus: 'idle' | 'loading' | 'error';
  onLoadOlder: () => void;
  onRetry: (clientId: string) => void;
}

// "Near the bottom": close enough that new messages should keep the view pinned there.
const STICK_TO_BOTTOM_PX = 120;

function Bubble({ mine, children }: { mine: boolean; children: ReactNode }) {
  return (
    <div
      className={
        'max-w-[85%] rounded-xl px-3 py-2 sm:max-w-[70%] ' +
        (mine ? 'self-end bg-accent text-on-accent' : 'self-start border border-line bg-surface')
      }
    >
      {children}
    </div>
  );
}

export function MessageList({
  messages,
  pending,
  myUserId,
  senderNames,
  hasOlder,
  olderStatus,
  onLoadOlder,
  onRetry,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previous = useRef({ firstId: '', lastKey: '', scrollHeight: 0, nearBottom: true });

  // Keep the reading position sensible as the list changes:
  // first render -> bottom; older page prepended -> stay on the same message;
  // new message at the end -> follow it if the reader was already at the bottom.
  const lastKey = `${messages.at(-1)?.id ?? ''}:${pending.length}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const before = previous.current;
    const firstId = messages[0]?.id ?? '';

    if (!before.firstId && !before.lastKey) {
      el.scrollTop = el.scrollHeight;
    } else if (firstId !== before.firstId && lastKey === before.lastKey) {
      el.scrollTop += el.scrollHeight - before.scrollHeight;
    } else if (lastKey !== before.lastKey && before.nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
    previous.current = { firstId, lastKey, scrollHeight: el.scrollHeight, nearBottom: before.nearBottom };
  }, [messages, lastKey]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    previous.current.nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
    previous.current.scrollHeight = el.scrollHeight;
  }

  const empty = messages.length === 0 && pending.length === 0;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {hasOlder && (
        <div className="mb-4 flex justify-center">
          <Button variant="secondary" onClick={onLoadOlder} disabled={olderStatus === 'loading'} className="h-9 px-3">
            {olderStatus === 'loading' ? 'Loading…' : olderStatus === 'error' ? 'Retry loading earlier messages' : 'Load earlier messages'}
          </Button>
        </div>
      )}

      {empty ? (
        <div className="grid h-full place-items-center text-center">
          <div>
            <p className="font-medium">No messages yet</p>
            <p className="mt-1 text-sm text-ink-muted">Say hello to start the conversation.</p>
          </div>
        </div>
      ) : (
        <div role="log" aria-label="Messages" className="flex flex-col gap-1.5">
          {messages.map((message, index) => {
            const mine = message.senderId === myUserId;
            const prev = messages[index - 1];
            const newDay = !prev || !isSameDay(prev.createdAt, message.createdAt);
            const showSender = !mine && senderNames && (newDay || prev?.senderId !== message.senderId);
            return (
              <Fragment key={message.id}>
                {newDay && (
                  <p className="my-3 text-center text-xs font-medium text-ink-muted">{formatDayLabel(message.createdAt)}</p>
                )}
                {showSender && (
                  <p className="mt-2 px-1 text-xs text-ink-muted">
                    {(message.senderId && senderNames.get(message.senderId)) ?? 'Deleted user'}
                  </p>
                )}
                <Bubble mine={mine}>
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  <time
                    dateTime={message.createdAt}
                    title={formatFullTimestamp(message.createdAt)}
                    className={`mt-0.5 block text-right text-[11px] ${mine ? 'text-on-accent' : 'text-ink-muted'}`}
                  >
                    {formatMessageTime(message.createdAt)}
                  </time>
                </Bubble>
              </Fragment>
            );
          })}

          {pending.map((p) => (
            <Bubble key={p.clientId} mine>
              <p className="whitespace-pre-wrap break-words">{p.content}</p>
              {p.status === 'sending' ? (
                <span className="mt-0.5 block text-right text-[11px] text-on-accent">Sending…</span>
              ) : (
                <span role="alert" className="mt-1 flex items-center justify-end gap-2 text-[11px] text-on-accent">
                  Not sent.
                  <button
                    type="button"
                    onClick={() => onRetry(p.clientId)}
                    className="rounded-sm font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-accent"
                  >
                    Retry
                  </button>
                </span>
              )}
            </Bubble>
          ))}
        </div>
      )}
    </div>
  );
}
