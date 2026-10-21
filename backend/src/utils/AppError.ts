import type { ErrorCode } from '@linka/shared';

/**
 * An error that is safe to show to the client.
 * Throw it from routes or services; the error handler turns it into a JSON response.
 * Any other error becomes a generic 500 so internal details never leak.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    /** Per-field messages for form errors, e.g. { username: 'That username is taken.' } */
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
