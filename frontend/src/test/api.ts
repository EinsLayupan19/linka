import { vi } from 'vitest';
import { jsonResponse } from './fetch';

export interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | null;
  contentType: string | null;
}

type Handler = (call: ApiCall) => Response | Promise<Response> | undefined;

/**
 * Replaces fetch with a tiny fake API. The handler answers by method and path; anything it
 * does not handle is a 404. Every call is recorded for assertions.
 */
export function mockApi(handler: Handler) {
  const calls: ApiCall[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const call: ApiCall = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      // JSON bodies are parsed; anything else (a file upload) is kept as sent.
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? undefined),
      authorization: new Headers(init?.headers).get('Authorization'),
      contentType: new Headers(init?.headers).get('Content-Type'),
    };
    calls.push(call);
    return (await handler(call)) ?? jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    /** Calls matching a method and path. */
    callsTo: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}
