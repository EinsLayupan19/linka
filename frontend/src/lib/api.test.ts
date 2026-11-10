import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jsonResponse, mockFetch } from '../test/fetch';
import { authMock } from '../test/supabaseMock';
import { ApiError, apiRequest } from './api';
import { SLOW_REQUEST_MS, slowRequests } from './serverWake';

vi.mock('./supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const schema = z.object({ value: z.number() });

async function expectApiError(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('apiRequest', () => {
  it('calls the configured API URL and returns validated data', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse({ value: 42 }));

    await expect(apiRequest('/api/thing', schema)).resolves.toEqual({ value: 42 });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/thing', expect.anything());
  });

  it('turns a network failure into a NETWORK_ERROR', async () => {
    mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await expectApiError(apiRequest('/api/thing', schema));
    expect(error.status).toBe(0);
    expect(error.code).toBe('NETWORK_ERROR');
  });

  it('uses the code and message from an API error response', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

    const error = await expectApiError(apiRequest('/api/thing', schema));
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Route not found' });
  });

  it('handles an error response that is not JSON', async () => {
    mockFetch().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));

    const error = await expectApiError(apiRequest('/api/thing', schema));
    expect(error).toMatchObject({ status: 502, code: 'UNKNOWN_ERROR' });
  });

  it('rejects a success response that does not match the schema', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ value: 'not a number' }));

    const error = await expectApiError(apiRequest('/api/thing', schema));
    expect(error.code).toBe('INVALID_RESPONSE');
  });

  it('passes aborts through unchanged so callers can ignore them', async () => {
    mockFetch().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(apiRequest('/api/thing', schema)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps per-field messages from validation errors', async () => {
    mockFetch().mockResolvedValue(
      jsonResponse(
        { error: { code: 'USERNAME_TAKEN', message: 'That username is taken.', fields: { username: 'Taken' } } },
        409,
      ),
    );

    const error = await expectApiError(apiRequest('/api/thing', schema));
    expect(error.fields).toEqual({ username: 'Taken' });
  });

  it('sends JSON bodies with a content type', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse({ value: 1 }));

    await apiRequest('/api/thing', schema, { method: 'POST', json: { name: 'Maya' } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{"name":"Maya"}');
  });
});

describe('apiRequest and a slow server', () => {
  afterEach(() => vi.useRealTimers());

  it('reports a request that keeps waiting (a waking server), until its answer arrives', async () => {
    vi.useFakeTimers();
    let answer!: (response: Response) => void;
    mockFetch().mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    const request = apiRequest('/api/thing', schema);
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_MS);
    expect(slowRequests.isSlow()).toBe(true);

    answer(jsonResponse({ value: 1 }));
    await request;
    expect(slowRequests.isSlow()).toBe(false);
  });

  it('does not report a slow file upload (that is the connection, not a sleeping server)', async () => {
    vi.useFakeTimers();
    let answer!: (response: Response) => void;
    mockFetch().mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    const upload = apiRequest('/api/thing', schema, { method: 'PUT', file: { body: new Blob(['x']), contentType: 'image/png' } });
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_MS * 2);
    expect(slowRequests.isSlow()).toBe(false);

    answer(jsonResponse({ value: 1 }));
    await upload;
  });

  it('stops reporting a slow request that fails', async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    mockFetch().mockReturnValue(new Promise<Response>((_, reject) => (fail = reject)));

    const request = apiRequest('/api/thing', schema).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_MS);
    expect(slowRequests.isSlow()).toBe(true);

    fail(new TypeError('Failed to fetch'));
    await request;
    expect(slowRequests.isSlow()).toBe(false);
  });
});

describe('apiRequest with auth', () => {
  it('attaches the current access token', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse({ value: 1 }));

    await apiRequest('/api/thing', schema, { auth: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-access-token');
  });

  it('does not send unauthenticated requests without auth', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse({ value: 1 }));

    await apiRequest('/api/thing', schema);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false);
  });

  it('fails with 401 before calling the API when there is no session', async () => {
    const fetchMock = mockFetch();
    authMock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });

    const error = await expectApiError(apiRequest('/api/thing', schema, { auth: true }));
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
