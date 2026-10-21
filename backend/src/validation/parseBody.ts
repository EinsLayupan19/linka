import type { z } from 'zod';
import { ErrorCode } from '@linka/shared';
import { AppError } from '../utils/AppError.js';

/**
 * Validates a request body with a shared Zod schema.
 * Returns the parsed (trimmed, normalised) data or throws a 400 with per-field messages.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const issue of result.error.issues) {
    const field = issue.path.join('.');
    if (!field) general.push(issue.message);
    else fields[field] ??= issue.message;
  }

  const message = general.length > 0 ? general.join(' ') : 'Some fields are invalid.';
  throw new AppError(400, ErrorCode.ValidationFailed, message, Object.keys(fields).length > 0 ? fields : undefined);
}
