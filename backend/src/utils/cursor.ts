import { z } from 'zod';
import { ErrorCode } from '@linka/shared';
import { AppError } from './AppError.js';

/**
 * Message pagination cursor: the (createdAt, id) of the oldest message on a page,
 * as base64url(JSON.stringify([createdAt, id])). Clients treat it as opaque.
 * Both parts are needed: createdAt alone is not unique, the id breaks ties.
 */
export interface MessageCursor {
  createdAt: Date;
  id: string;
}

const cursorPayloadSchema = z.tuple([z.iso.datetime(), z.uuid()]);

export function encodeCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

/** Throws a 400 for anything that is not a cursor this API issued. */
export function decodeCursor(value: string): MessageCursor {
  const invalid = () =>
    new AppError(400, ErrorCode.ValidationFailed, 'Invalid cursor.', { before: 'Invalid cursor.' });

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = cursorPayloadSchema.safeParse(decoded);
  if (!parsed.success) throw invalid();
  return { createdAt: new Date(parsed.data[0]), id: parsed.data[1] };
}
