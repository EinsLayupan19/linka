import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { mockApi } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { installUploadFakes, testFile } from '../test/xhr';
import { attachmentUrl, clearAttachmentUrls } from './attachmentUrls';
import { putFile } from './attachments';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

describe('putFile (direct upload to the signed URL)', () => {
  it('PUTs the file with its type and reports progress', async () => {
    const fakes = installUploadFakes();
    const file = testFile('beach.png', 'image/png');
    const progress: number[] = [];

    const done = putFile('https://storage.test/upload?token=t', file, 'image/png', { onProgress: (p) => progress.push(p) });
    const xhr = fakes.latest()!;
    xhr.progress(512, 2048);
    xhr.progress(2048, 2048);
    xhr.respond(200);
    await done;

    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://storage.test/upload?token=t');
    expect(xhr.headers.get('content-type')).toBe('image/png');
    // No credentials of any kind: the signed URL alone authorizes the upload.
    expect(xhr.headers.has('authorization')).toBe(false);
    expect(xhr.body).toBe(file);
    expect(progress).toEqual([0.25, 1, 1]);
  });

  it('rejects with a friendly error when Storage refuses or the network fails', async () => {
    const fakes = installUploadFakes();
    const refused = putFile('https://storage.test/u', testFile('a.png', 'image/png'), 'image/png');
    fakes.latest()!.respond(403);
    await expect(refused).rejects.toMatchObject({ status: 403, message: 'The upload did not go through. Try again.' });

    const offline = putFile('https://storage.test/u', testFile('a.png', 'image/png'), 'image/png');
    fakes.latest()!.failNetwork();
    const error = await offline.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('aborts the request when cancelled', async () => {
    const fakes = installUploadFakes();
    const controller = new AbortController();
    const upload = putFile('https://storage.test/u', testFile('a.png', 'image/png'), 'image/png', { signal: controller.signal });
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakes.latest()!.aborted).toBe(true);

    const alreadyAborted = putFile('https://storage.test/u', testFile('a.png', 'image/png'), 'image/png', { signal: controller.signal });
    await expect(alreadyAborted).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('attachment URL cache', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const expiresIn = (ms: number) => new Date(Date.now() + ms).toISOString();

  beforeEach(() => clearAttachmentUrls());
  afterEach(() => clearAttachmentUrls());

  function urlsApi(expiresAt = () => expiresIn(600_000), visible = (id: string) => id !== ids[1]) {
    return mockApi((call) => {
      if (call.method === 'POST' && call.path === '/api/attachments/urls') {
        const requested = (call.body as { attachmentIds: string[] }).attachmentIds;
        return jsonResponse({ urls: requested.filter(visible).map((id) => ({ id, url: `https://storage.test/sign/${id}`, expiresAt: expiresAt() })) });
      }
      return undefined;
    });
  }

  it('batches requests from the same moment into one call, in chunks of 50', async () => {
    const api = urlsApi();
    const results = await Promise.all(ids.map((id) => attachmentUrl(id)));

    const calls = api.callsTo('POST', '/api/attachments/urls');
    expect(calls.map((c) => (c.body as { attachmentIds: string[] }).attachmentIds.length)).toEqual([50, 10]);
    expect(results[0]?.url).toBe(`https://storage.test/sign/${ids[0]}`);
    // Not visible to this user: null, never an error.
    expect(results[1]).toBeNull();
  });

  it('reuses a cached URL until it is about to expire', async () => {
    const api = urlsApi();
    await attachmentUrl(ids[0]!);
    await attachmentUrl(ids[0]!);
    expect(api.callsTo('POST', '/api/attachments/urls')).toHaveLength(1);

    await attachmentUrl(ids[0]!, { force: true });
    expect(api.callsTo('POST', '/api/attachments/urls')).toHaveLength(2);
  });

  it('fetches again when the cached URL expires within a minute', async () => {
    const api = urlsApi(() => expiresIn(30_000));
    await attachmentUrl(ids[0]!);
    await attachmentUrl(ids[0]!);
    expect(api.callsTo('POST', '/api/attachments/urls')).toHaveLength(2);
  });

  it('rejects everyone waiting when the request fails, and caches nothing', async () => {
    mockApi(() => jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: 'File storage is unavailable.' } }, 503));
    await expect(attachmentUrl(ids[0]!)).rejects.toMatchObject({ status: 503 });
    const api = urlsApi();
    expect(await attachmentUrl(ids[0]!)).not.toBeNull();
    expect(api.callsTo('POST', '/api/attachments/urls')).toHaveLength(1);
  });

  it('forgets everything when cleared (sign-out)', async () => {
    const api = urlsApi();
    await attachmentUrl(ids[0]!);
    clearAttachmentUrls();
    await attachmentUrl(ids[0]!);
    expect(api.callsTo('POST', '/api/attachments/urls')).toHaveLength(2);
  });
});
