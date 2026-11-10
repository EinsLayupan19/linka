import { useEffect, useRef, useState } from 'react';
import type { Message } from '@linka/shared';
import { ApiError } from '../lib/api';
import { markRead } from '../services/receipts';

const READ_DELAY_MS = 600;

/** Waits between retries of a read that failed for a passing reason (tests shorten these). */
export const readRetry = { delaysMs: [2000, 5000, 15000] };

/** No connection, rate limited, or a server-side failure: worth trying again shortly. */
function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

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
 *
 * Reliability:
 * - a transient failure (no connection, 429, 5xx) is retried after readRetry.delaysMs, then again
 *   whenever the tab becomes visible; permanent failures (other 4xx) are not retried
 * - "already read further" (MARKER_BEHIND) is a confirmed read: the server is past this point
 * - a read is not sent again while the same (or a later) one is still on its way
 * - leaving the conversation stops retries; a request already sent still reports its result
 * onRead is only ever called with a read the server confirmed.
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

  /** The read position currently being saved, if any. */
  const inFlight = useRef<string | null>(null);
  /** Retries used for the current target; a new target starts over. */
  const failures = useRef(0);
  const [retryTick, setRetryTick] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    failures.current = 0;
  }, [target]);

  // Leaving the conversation: no more retries (a request already sent still reports back).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!target || !visible || !atBottom) return;
    // Already confirmed this far (e.g. the previous request): no write.
    if (confirmed.current && othersNewest && othersNewest <= confirmed.current) return;
    // This read (or a later one) is already on its way.
    if (inFlight.current && inFlight.current >= target) return;
    const timer = setTimeout(() => {
      inFlight.current = target;
      markRead(conversationId, target)
        .then(
          (markers) => {
            if (markers.lastReadAt && (!confirmed.current || markers.lastReadAt > confirmed.current)) {
              confirmed.current = markers.lastReadAt;
            }
            if (markers.lastReadAt) onReadRef.current(markers.lastReadAt);
          },
          (error: unknown) => {
            if (error instanceof ApiError && error.code === 'MARKER_BEHIND') {
              // The server already has a later read (another tab or device): everything up to
              // `target` is confirmed read.
              if (!confirmed.current || target > confirmed.current) confirmed.current = target;
              onReadRef.current(target);
              return;
            }
            const delay = readRetry.delaysMs[failures.current];
            if (!mounted.current || !isTransient(error) || delay === undefined) return;
            failures.current += 1;
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => setRetryTick((n) => n + 1), delay);
          },
        )
        .finally(() => {
          if (inFlight.current === target) inFlight.current = null;
        });
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conversationId, target, othersNewest, visible, atBottom, retryTick]);
}
