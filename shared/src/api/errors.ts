import { z } from 'zod';

/**
 * Every error the API returns has this shape, so the frontend can handle
 * failures in one place instead of guessing per endpoint.
 * `fields` maps form field names to messages for validation and conflict errors.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Machine-readable error codes. Add new codes here as features need them. */
export const ErrorCode = {
  BadRequest: 'BAD_REQUEST',
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthorized: 'UNAUTHORIZED',
  /** Signed in and a member, but the role does not allow this action. */
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  ProfileNotFound: 'PROFILE_NOT_FOUND',
  ProfileExists: 'PROFILE_EXISTS',
  UsernameTaken: 'USERNAME_TAKEN',
  /** Also returned to non-members, so the API never reveals that a conversation exists. */
  ConversationNotFound: 'CONVERSATION_NOT_FOUND',
  MemberNotFound: 'MEMBER_NOT_FOUND',
  AlreadyMember: 'ALREADY_MEMBER',
  /** The owner must transfer ownership before leaving. */
  OwnerCannotLeave: 'OWNER_CANNOT_LEAVE',
  CallInProgress: 'CALL_IN_PROGRESS',
  /** A read marker update would move it backwards (e.g. a stale tab); nothing changed. */
  MarkerBehind: 'MARKER_BEHIND',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  Internal: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
