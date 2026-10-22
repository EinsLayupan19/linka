import {
  DELIVERY_BATCH_MAX,
  markDeliveredResultSchema,
  memberMarkersSchema,
  type MemberMarkers,
} from '@linka/shared';
import { z } from 'zod';
import { ApiError, apiRequest } from '../lib/api';

/** Moves the caller's read marker in a conversation. Rejects with MARKER_BEHIND if already further. */
export function markRead(conversationId: string, lastReadAt: string): Promise<MemberMarkers> {
  return apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}/read`, memberMarkersSchema, {
    auth: true,
    method: 'PUT',
    json: { lastReadAt },
  });
}

export function markDelivered(items: { conversationId: string; lastDeliveredAt: string }[]) {
  return apiRequest('/api/conversations/delivered', markDeliveredResultSchema, {
    auth: true,
    method: 'POST',
    json: { conversations: items },
  });
}

/** Reports activity for "Last seen". `keepalive` lets it finish while the tab is closing. */
export function reportSeen(options: { keepalive?: boolean } = {}): Promise<undefined> {
  return apiRequest('/api/users/me/seen', z.undefined(), { auth: true, method: 'POST', keepalive: options.keepalive ?? false });
}

export interface DeliveryReporter {
  /** The server's marker as last seen (from the API), so nothing older is ever sent. */
  seed: (conversationId: string, lastDeliveredAt: string | null) => void;
  /** This client received a message from someone else created at `createdAt`. */
  report: (conversationId: string, createdAt: string) => void;
  /** Sends whatever is pending now (e.g. when leaving the page). */
  flush: () => void;
  dispose: () => void;
}

/**
 * Coalesces delivery receipts: many received messages, in many conversations, become one
 * request per flush window carrying only the newest time per conversation, and only times past
 * what the server already has. Markers only move forward, so dropping a failed batch is safe:
 * the next received message reports a time at least as new.
 */
export function createDeliveryReporter(flushDelayMs = 1500): DeliveryReporter {
  const acknowledged = new Map<string, string>();
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const isNewer = (conversationId: string, at: string, map: Map<string, string>) => {
    const known = map.get(conversationId);
    return !known || at > known;
  };

  async function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return;
    const items = [...pending].map(([conversationId, lastDeliveredAt]) => ({ conversationId, lastDeliveredAt }));
    pending.clear();

    for (let i = 0; i < items.length; i += DELIVERY_BATCH_MAX) {
      const batch = items.slice(i, i + DELIVERY_BATCH_MAX);
      try {
        await markDelivered(batch);
        for (const item of batch) {
          if (isNewer(item.conversationId, item.lastDeliveredAt, acknowledged)) {
            acknowledged.set(item.conversationId, item.lastDeliveredAt);
          }
        }
      } catch (error) {
        // 404: left one of these conversations. Anything else: try again with the next message.
        if (!(error instanceof ApiError)) console.error('Could not report delivery:', error);
      }
    }
  }

  return {
    seed(conversationId, lastDeliveredAt) {
      if (lastDeliveredAt && isNewer(conversationId, lastDeliveredAt, acknowledged)) {
        acknowledged.set(conversationId, lastDeliveredAt);
      }
    },
    report(conversationId, createdAt) {
      if (disposed) return;
      if (!isNewer(conversationId, createdAt, acknowledged) || !isNewer(conversationId, createdAt, pending)) return;
      pending.set(conversationId, createdAt);
      timer ??= setTimeout(() => void flush(), flushDelayMs);
    },
    flush: () => void flush(),
    dispose() {
      void flush();
      disposed = true;
    },
  };
}
