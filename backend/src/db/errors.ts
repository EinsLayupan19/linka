// Postgres error codes we react to. https://www.postgresql.org/docs/current/errcodes-appendix.html
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';

/** The Postgres error code of a failed query. Drizzle wraps driver errors, so causes are checked too. */
export function postgresErrorCode(error: unknown): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}
