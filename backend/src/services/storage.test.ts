import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../utils/AppError.js';
import { createSupabaseStorage } from './storage.js';

// The Supabase gateway against a stubbed network. What is checked is our side: we read only the
// first bytes of an object (Range + bounded read), map failures to a generic 503, and never put
// the secret key anywhere but the Authorization header. Real Supabase is not exercised here.

const SUPABASE_URL = 'https://project.supabase.test';
const SECRET = 'sb_secret_test_value_not_real_0000';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
let calls: { url: URL; init: RequestInit }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A response body that streams `total` bytes in 64-byte chunks and records how much was pulled. */
function streamingBody(total: number) {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const chunk = new Uint8Array(Math.min(64, total - sent)).fill(0x41);
      if (sent === 0) chunk.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, sent: () => sent };
}

describe('Supabase storage gateway', () => {
  it('inspects an object by reading only its first bytes', async () => {
    const body = streamingBody(1_000_000);
    handler = (url, init) => {
      if (url.pathname.includes('/object/info/')) return json({ size: 1_000_000, content_type: 'application/pdf', contentType: 'application/pdf' });
      if (url.pathname.includes('/object/sign/') && init.method === 'POST') return json({ signedURL: '/object/sign/attachments/c/u/a.pdf?token=t' });
      // The range read: a server that ignores Range and sends the whole file.
      return new Response(body.stream, { status: 200 });
    };
    const storage = createSupabaseStorage(SUPABASE_URL, SECRET);

    const object = await storage.inspect('attachments', 'c/u/a.pdf', 512);

    expect(object?.sizeBytes).toBe(1_000_000);
    expect(object?.head.byteLength).toBe(512);
    expect(new TextDecoder().decode(object!.head.slice(0, 5))).toBe('%PDF-');
    expect(body.sent()).toBeLessThan(4096); // stopped early, never buffered the file
    const rangeCall = calls.at(-1)!;
    expect(new Headers(rangeCall.init.headers).get('Range')).toBe('bytes=0-511');
    // The signed download URL carries a token, not the secret key.
    expect(rangeCall.url.toString()).not.toContain(SECRET);
    expect(new Headers(rangeCall.init.headers).get('Authorization')).toBeNull();
  });

  it('answers 503 (not "rejected") when Storage reports no size, so a good upload is never deleted', async () => {
    handler = () => json({ name: 'a.pdf', content_type: 'application/pdf' });
    const error = await createSupabaseStorage(SUPABASE_URL, SECRET)
      .inspect('attachments', 'c/u/a.pdf', 512)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 503 });
  });

  it('reports a missing object as null', async () => {
    handler = () => json({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 404);
    expect(await createSupabaseStorage(SUPABASE_URL, SECRET).inspect('attachments', 'c/u/a.pdf', 512)).toBeNull();
  });

  it('turns storage failures into a generic 503 without details', async () => {
    handler = () => json({ statusCode: '500', error: 'internal', message: 'db password is hunter2' }, 500);
    const storage = createSupabaseStorage(SUPABASE_URL, SECRET);

    for (const run of [
      () => storage.createUploadUrl('attachments', 'c/u/a.pdf'),
      () => storage.upload('avatars', 'u/a.png', new Uint8Array([1]), 'image/png'),
      () => storage.remove('attachments', ['c/u/a.pdf']),
      () => storage.signedUrls('attachments', ['c/u/a.pdf'], 600),
    ]) {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ statusCode: 503, message: 'File storage is unavailable. Try again shortly.' });
      expect(JSON.stringify(error)).not.toContain('hunter2');
    }
  });

  it('signs a batch of paths and drops any that could not be signed', async () => {
    handler = () =>
      json([
        { path: 'u/a.png', signedURL: '/object/sign/avatars/u/a.png?token=1', error: null },
        { path: 'u/gone.png', signedURL: null, error: 'Either the object does not exist or you do not have access to it' },
      ]);
    const urls = await createSupabaseStorage(SUPABASE_URL, SECRET).signedUrls('avatars', ['u/a.png', 'u/gone.png'], 3600);
    expect([...urls.keys()]).toEqual(['u/a.png']);
    expect(urls.get('u/a.png')).toMatch(/^https:\/\/project\.supabase\.test\/storage\/v1\/object\/sign\/avatars\/u\/a\.png\?token=1/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expiresIn: 3600, paths: ['u/a.png', 'u/gone.png'] });
  });

  it('makes no network call for empty batches', async () => {
    handler = () => json({});
    const storage = createSupabaseStorage(SUPABASE_URL, SECRET);
    await storage.remove('attachments', []);
    expect(await storage.signedUrls('avatars', [], 60)).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it('never overwrites when uploading', async () => {
    handler = () => json({ Key: 'avatars/u/a.png', Id: 'x' });
    await createSupabaseStorage(SUPABASE_URL, SECRET).upload('avatars', 'u/a.png', new Uint8Array([1, 2]), 'image/png');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('x-upsert')).toBe('false');
    expect(calls[0]!.init.method).toBe('POST');
  });
});
