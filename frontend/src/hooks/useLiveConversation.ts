import { useCallback, useEffect, useRef, useState } from 'react';
import { TYPING_THROTTLE_MS, TYPING_TIMEOUT_MS } from '@linka/shared';
import { joinLiveConversation, type LiveConversation } from '../services/realtime';

/**
 * Presence and typing for the open conversation, over its live channel. Nothing is stored.
 *
 * - online: other members who have this conversation open right now
 * - typing: other members typing; each entry expires TYPING_TIMEOUT_MS after their last event
 * - notifyTyping(): call on every keystroke; sends at most one event per TYPING_THROTTLE_MS and
 *   a "stopped" event after TYPING_TIMEOUT_MS of silence
 *
 * Events from people who are not members (per `memberIds`) or from yourself are ignored, and
 * all state clears when the connection drops or the conversation closes.
 */
export function useLiveConversation(
  conversationId: string,
  myUserId: string,
  memberIds: ReadonlySet<string>,
  /** Join only once membership is confirmed (the conversation loaded). */
  enabled = true,
) {
  const [online, setOnline] = useState<string[]>([]);
  const [typing, setTyping] = useState<ReadonlyMap<string, number>>(new Map());

  const members = useRef(memberIds);
  useEffect(() => {
    members.current = memberIds;
  }, [memberIds]);

  const live = useRef<LiveConversation | null>(null);
  const sentAt = useRef(0);
  const typingActive = useRef(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const connection = joinLiveConversation(conversationId, myUserId, {
      onPresence: (userIds) => setOnline(userIds.filter((id) => id !== myUserId)),
      onTyping: (event) => {
        if (event.userId === myUserId || !members.current.has(event.userId)) return;
        setTyping((current) => {
          const next = new Map(current);
          if (event.typing) next.set(event.userId, Date.now() + TYPING_TIMEOUT_MS);
          else next.delete(event.userId);
          return next;
        });
      },
      onStatus: (status) => {
        if (status !== 'live') {
          // Disconnected: we no longer know who is here or typing.
          setOnline([]);
          setTyping(new Map());
        }
      },
    });
    live.current = connection;

    return () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      if (typingActive.current) connection.sendTyping(false);
      typingActive.current = false;
      sentAt.current = 0;
      connection.leave();
      live.current = null;
      setOnline([]);
      setTyping(new Map());
    };
  }, [conversationId, myUserId, enabled]);

  // Expire typing indicators that were not refreshed in time.
  useEffect(() => {
    if (typing.size === 0) return;
    const nextExpiry = Math.min(...typing.values());
    const timer = setTimeout(() => {
      const now = Date.now();
      setTyping((current) => new Map([...current].filter(([, expiresAt]) => expiresAt > now)));
    }, Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [typing]);

  const stopTyping = useCallback(() => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    if (typingActive.current) live.current?.sendTyping(false);
    typingActive.current = false;
    sentAt.current = 0;
  }, []);

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (!typingActive.current || now - sentAt.current >= TYPING_THROTTLE_MS) {
      live.current?.sendTyping(true);
      typingActive.current = true;
      sentAt.current = now;
    }
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(stopTyping, TYPING_TIMEOUT_MS);
  }, [stopTyping]);

  // Render from props, not refs: only current members other than me.
  const isOther = (userId: string) => userId !== myUserId && memberIds.has(userId);
  return {
    onlineUserIds: online.filter(isOther),
    typingUserIds: [...typing.keys()].filter(isOther),
    notifyTyping,
    stopTyping,
  };
}
