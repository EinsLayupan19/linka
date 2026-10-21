import { pgEnum } from 'drizzle-orm/pg-core';
import { CALL_STATUSES, CALL_TYPES, CONVERSATION_TYPES, MEMBER_ROLES, MESSAGE_TYPES } from '@linka/shared';

// Postgres enum types, built from the same value lists as the shared Zod enums so the
// API contract and the database can never disagree. Adding a value later is an
// `ALTER TYPE ... ADD VALUE` migration.

export const conversationType = pgEnum('conversation_type', CONVERSATION_TYPES);
export const memberRole = pgEnum('member_role', MEMBER_ROLES);
export const messageType = pgEnum('message_type', MESSAGE_TYPES);
export const callType = pgEnum('call_type', CALL_TYPES);
export const callStatus = pgEnum('call_status', CALL_STATUSES);
