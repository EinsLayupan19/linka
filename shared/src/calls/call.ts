import { z } from 'zod';

export const CALL_TYPES = ['voice', 'video'] as const;
export const callTypeSchema = z.enum(CALL_TYPES);
export type CallType = z.infer<typeof callTypeSchema>;

/**
 * ringing -> active -> ended
 * ringing -> missed | declined
 * The lifecycle itself is implemented with calling (Phase 7).
 */
export const CALL_STATUSES = ['ringing', 'active', 'ended', 'missed', 'declined'] as const;
export const callStatusSchema = z.enum(CALL_STATUSES);
export type CallStatus = z.infer<typeof callStatusSchema>;

export const callParticipantSchema = z.object({
  userId: z.uuid(),
  joinedAt: z.iso.datetime({ offset: true }).nullable(),
  leftAt: z.iso.datetime({ offset: true }).nullable(),
});

export const callSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  initiatorId: z.uuid().nullable(),
  type: callTypeSchema,
  status: callStatusSchema,
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  participants: z.array(callParticipantSchema),
});

export type Call = z.infer<typeof callSchema>;
