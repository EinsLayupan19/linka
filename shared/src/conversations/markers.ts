import { z } from 'zod';

/**
 * Read and delivery state is two timestamps per member (conversation_members), never a row
 * per message: a message is delivered to / read by a member when its createdAt is at or
 * before that member's marker. Markers only move forward.
 */

/** Unread counts stop at this number (shown as "99+"); counting further is wasted work. */
export const UNREAD_COUNT_CAP = 100;
/** Max conversations per delivery batch: one conversation list page. */
export const DELIVERY_BATCH_MAX = 50;

const markerTimestamp = z.iso.datetime('Invalid timestamp.');

/** Body of PUT /api/conversations/:conversationId/read. Applies to the caller only. */
export const markReadSchema = z.strictObject({
  lastReadAt: markerTimestamp,
});
export type MarkReadInput = z.infer<typeof markReadSchema>;

/** Body of POST /api/conversations/delivered. Applies to the caller only. */
export const markDeliveredSchema = z.strictObject({
  conversations: z
    .array(
      z.strictObject({
        conversationId: z.uuid('Invalid conversation id.'),
        lastDeliveredAt: markerTimestamp,
      }),
    )
    .min(1, 'Nothing to mark.')
    .max(DELIVERY_BATCH_MAX, `At most ${DELIVERY_BATCH_MAX} conversations per request.`),
});
export type MarkDeliveredInput = z.infer<typeof markDeliveredSchema>;

/** The caller's markers after an update. */
export const memberMarkersSchema = z.object({
  conversationId: z.uuid(),
  lastDeliveredAt: z.iso.datetime().nullable(),
  lastReadAt: z.iso.datetime().nullable(),
});
export type MemberMarkers = z.infer<typeof memberMarkersSchema>;

export const markDeliveredResultSchema = z.object({
  /** Conversations whose marker moved; the others were already at or past the given time. */
  updated: z.array(memberMarkersSchema),
});
export type MarkDeliveredResult = z.infer<typeof markDeliveredResultSchema>;
