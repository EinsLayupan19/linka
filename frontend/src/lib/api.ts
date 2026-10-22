import { apiErrorResponseSchema } from '@linka/shared';
import type { z } from 'zod';
import { env } from './env';
import { getSupabase } from './supabase';

/** Error codes created in the browser (the API's own codes come from @linka/shared). */
export const ClientErrorCode = {
  Network: 'NETWORK_ERROR',
  InvalidResponse: 'INVALID_RESPONSE',
  Unknown: 'UNKNOWN_ERROR',
} as const;

/** Every failed API call rejects with this, so the UI has one error type to handle. */
export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never reached the server. */
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Per-field messages for form errors. */
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, ClientErrorCode.Unknown, 'Something went wrong. Please try again.');
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /** Send the signed-in user's access token. */
  auth?: boolean;
  /** Request body, sent as JSON. */
  json?: unknown;
  /** Request body sent as raw bytes with this type (file uploads); not combined with json. */
  file?: { body: Blob; contentType: string };
}

/** The current access token. supabase-js refreshes it first if it has expired. */
async function accessToken(): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  if (!data.session) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
  return data.session.access_token;
}

/**
 * Calls the Linka API and validates the response body against `schema`.
 * Aborted requests reject with the original AbortError so callers can ignore them.
 */
export async function apiRequest<T>(path: string, schema: z.ZodType<T>, options: ApiRequestOptions = {}): Promise<T> {
  const { auth, json, file, ...init } = options;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  if (file) headers.set('Content-Type', file.contentType);
  if (auth) headers.set('Authorization', `Bearer ${await accessToken()}`);

  let response: Response;
  try {
    response = await fetch(`${env.VITE_API_URL}${path}`, {
      ...init,
      headers,
      body: file ? file.body : json === undefined ? null : JSON.stringify(json),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, ClientErrorCode.Network, 'Could not reach the server. Check your connection and try again.');
  }

  // 204 No Content has no body to read.
  const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, fields } = parsed.data.error;
      throw new ApiError(response.status, code, message, fields);
    }
    throw new ApiError(response.status, ClientErrorCode.Unknown, `Request failed with status ${response.status}.`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(response.status, ClientErrorCode.InvalidResponse, 'The server sent an unexpected response.');
  }
  return parsed.data;
}
