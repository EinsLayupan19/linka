import { useEffect, useRef, useState } from 'react';
import type { Message } from '@linka/shared';
import { ApiError } from '../lib/api';
import { markRead } from '../services/receipts';

const READ_DELAY_MS = 600;

function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * Advances the user's read marker in the open conversation once they can actually see the
 * newest messages: the tab is visible and the list is scrolled to the bottom. Coalesced: one
 * request after a short pause, only when someone else's message is newer than the marker, and
 * never backwards.
 */
export function useReadTracking(options: {
  conversationId: string;
  messages: Message[];
  myUserId: string;
  myLastReadAt: string | null;
  atBottom: boolean;
  onRead: (lastReadAt: string) => void;
}) {
  const { conversationId, messages, myUserId, myLastReadAt, atBottom, onRead } = options;
  const visible = usePageVisible();
  const confirmed = useRef<string | null>(myLastReadAt);
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
    if (myLastReadAt && (!confirmed.current || myLastReadAt > confirmed.current)) confirmed.current = myLastReadAt;
  });

  // Read up to the newest message, but only bother when someone else wrote something unread.
  const newest = messages.at(-1);
  const newestFromOthers = messages.findLast((m) => m.senderId !== myUserId);
  const target =
    newest && newestFromOthers && (!myLastReadAt || newestFromOthers.createdAt > myLastReadAt) ? newest.createdAt : null;
  const othersNewest = newestFromOthers?.createdAt ?? null;

  useEffect(() => {
    if (!target || !visible || !atBottom) return;
    // Already confirmed this far (e.g. the previous request): no write.
    if (confirmed.current && othersNewest && othersNewest <= confirmed.current) return;
    const timer = setTimeout(() => {
      markRead(conversationId, target).then(
        (markers) => {
          if (markers.lastReadAt && (!confirmed.current || markers.lastReadAt > confirmed.current)) {
            confirmed.current = markers.lastReadAt;
          }
          if (markers.lastReadAt) onReadRef.current(markers.lastReadAt);
        },
        (error: unknown) => {
          // Already read further (another tab): nothing to do. Other failures retry on the next change.
          if (error instanceof ApiError && error.code === 'MARKER_BEHIND') confirmed.current = target;
        },
      );
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conversationId, target, othersNewest, visible, atBottom]);
}
