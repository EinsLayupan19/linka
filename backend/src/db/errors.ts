// Postgres error codes we react to. https://www.postgresql.org/docs/current/errcodes-appendix.html
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';

/** The constraint a failed query violated, if the driver reports one (postgres.js and PGlite name it differently). */
export function postgresConstraint(error: unknown): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const { constraint, constraint_name } = current as { constraint?: unknown; constraint_name?: unknown };
    const name = constraint ?? constraint_name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/** The Postgres error code of a failed query. Drizzle wraps driver errors, so causes are checked too. */
export function postgresErrorCode(error: unknown): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}
