import { z } from 'zod';

export const CALL_TYPES = ['voice', 'video'] as const;
export const callTypeSchema = z.enum(CALL_TYPES);
export type CallType = z.infer<typeof callTypeSchema>;

/**
 * ringing -> active -> ended
 * ringing -> missed | declined
 * ringing -> ended is not used: an unanswered call becomes missed (timeout or the caller
 * cancelled) or declined (the callee refused).
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

// --- Calling (Phase 7: 1:1 voice) ---

/** Types that can be started today. Video arrives with Phase 8. */
export const SUPPORTED_CALL_TYPES = ['voice'] as const;

/** Body of POST /api/calls. Calls are between the two members of a 1:1 conversation. */
export const createCallSchema = z.strictObject({
  conversationId: z.uuid('Invalid conversation id.'),
  type: z.enum(SUPPORTED_CALL_TYPES, 'Only voice calls are available.'),
});

export type CreateCallInput = z.infer<typeof createCallSchema>;

/** Response of GET /api/calls/ongoing: the caller's ringing or active calls. */
export const callListSchema = z.object({ calls: z.array(callSchema) });

/** An unanswered call stops ringing after this long (caller and callee time out locally too). */
export const CALL_RING_TIMEOUT_SECONDS = 45;
/** Every connected participant reports that the call is still alive this often... */
export const CALL_HEARTBEAT_SECONDS = 20;
/** ...and an active call nobody reported on for this long is ended by the server. */
export const CALL_STALE_SECONDS = 60;
/** A ringing call is marked missed by the server this long after it started (fallback). */
export const CALL_RING_EXPIRY_SECONDS = 60;

/** STUN/TURN servers for RTCPeerConnection. TURN credentials, if any, come from the server. */
export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string()).min(1)]).refine(
    (urls) => (Array.isArray(urls) ? urls : [urls]).every((url) => /^(stun|stuns|turn|turns):/.test(url)),
    'ICE server URLs must start with stun:, stuns:, turn: or turns:.',
  ),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServer = z.infer<typeof iceServerSchema>;

/** Response of GET /api/calls/ice-servers. */
export const iceServersResponseSchema = z.object({ iceServers: z.array(iceServerSchema) });

/** A call that still needs attention (it rings or is connected). */
export const ONGOING_CALL_STATUSES = ['ringing', 'active'] as const satisfies readonly CallStatus[];
export const isOngoingCall = (call: Pick<Call, 'status'>) => (ONGOING_CALL_STATUSES as readonly string[]).includes(call.status);
