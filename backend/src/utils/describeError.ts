import { DrizzleQueryError } from 'drizzle-orm/errors';

/**
 * Text for the server log that is safe to keep: what went wrong and where, without the data.
 *
 * A failed Drizzle query carries the SQL *and its parameters* (message text, emails, user ids) in
 * its message and stack, so for those only the database's own reason and error code are kept.
 * Other errors keep their stack, which is what makes a bug findable.
 */
export function describeError(error: unknown): string {
  if (error instanceof DrizzleQueryError) {
    return `Database query failed: ${databaseReason(error.cause)}`;
  }
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function databaseReason(cause: unknown): string {
  if (!(cause instanceof Error)) return 'unknown reason';
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? `${cause.message} [${code}]` : cause.message;
}
