import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '@linka/shared';
import { AppError } from '../utils/AppError.js';

export type Bucket = 'attachments' | 'avatars';

/** What the server can learn about a stored object without downloading it. */
export interface StoredObject {
  sizeBytes: number;
  contentType: string | null;
  /** The first bytes of the file (for checking its real type), at most the requested count. */
  head: Uint8Array;
}

/**
 * Private file storage. Only the API talks to it (with the server-only secret key); browsers
 * get short-lived signed URLs for exactly one object at a time.
 */
export interface StorageGateway {
  /** A single-use URL the browser can PUT exactly this object to. */
  createUploadUrl(bucket: Bucket, path: string): Promise<{ url: string; expiresAt: Date }>;
  /** Size, stored type and the first `headBytes` bytes; null if nothing was uploaded there. */
  inspect(bucket: Bucket, path: string, headBytes: number): Promise<StoredObject | null>;
  /** Server-side upload of small files (profile pictures). Never overwrites. */
  upload(bucket: Bucket, path: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Deletes objects; missing objects are not an error. */
  remove(bucket: Bucket, paths: string[]): Promise<void>;
  /** Short-lived download URLs, keyed by path. Paths that cannot be signed are absent. */
  signedUrls(bucket: Bucket, paths: string[], expiresInSeconds: number): Promise<Map<string, string>>;
}

/** Supabase signed upload URLs are valid for 2 hours (fixed by Supabase). */
const SIGNED_UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1000;

const unavailable = () => new AppError(503, ErrorCode.ServiceUnavailable, 'File storage is unavailable. Try again shortly.');

function fail(operation: string, error: unknown): never {
  // Details stay in the server log; callers get a generic 503.
  console.error(`Storage ${operation} failed:`, error instanceof Error ? error.message : error);
  throw unavailable();
}

/** Reads at most `limit` bytes from a response body, then stops (never buffers a whole file). */
async function readHead(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const head = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, head.byteLength - offset);
    head.set(part, offset);
    offset += part.byteLength;
    if (offset >= head.byteLength) break;
  }
  return head;
}

export function createSupabaseStorage(supabaseUrl: string, secretKey: string): StorageGateway {
  const client: SupabaseClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = (name: Bucket) => client.storage.from(name);

  return {
    async createUploadUrl(name, path) {
      const { data, error } = await bucket(name).createSignedUploadUrl(path);
      if (error || !data) fail('createSignedUploadUrl', error);
      return { url: data.signedUrl, expiresAt: new Date(Date.now() + SIGNED_UPLOAD_LIFETIME_MS) };
    },

    async inspect(name, path, headBytes) {
      const { data: info, error } = await bucket(name).info(path);
      if (error || !info) return null; // not uploaded (or not finished)
      // Without a size the file cannot be checked; never mistake that for a bad upload.
      const sizeBytes = Number(info.size);
      if (info.size == null || !Number.isFinite(sizeBytes)) fail('info', 'no object size');

      // Read only the first bytes, through a one-minute signed URL and a Range request.
      const { data: signed, error: signError } = await bucket(name).createSignedUrl(path, 60);
      if (signError || !signed) fail('createSignedUrl', signError);
      let response: Response;
      try {
        response = await fetch(signed.signedUrl, { headers: { Range: `bytes=0-${headBytes - 1}` } });
      } catch (fetchError) {
        fail('range read', fetchError);
      }
      if (!response.ok) fail('range read', `HTTP ${response.status}`);

      return {
        sizeBytes,
        contentType: info.contentType ?? null,
        head: await readHead(response, headBytes),
      };
    },

    async upload(name, path, body, contentType) {
      const { error } = await bucket(name).upload(path, body, { contentType, upsert: false });
      if (error) fail('upload', error);
    },

    async remove(name, paths) {
      if (paths.length === 0) return;
      const { error } = await bucket(name).remove(paths);
      if (error) fail('remove', error);
    },

    async signedUrls(name, paths, expiresInSeconds) {
      if (paths.length === 0) return new Map();
      const { data, error } = await bucket(name).createSignedUrls(paths, expiresInSeconds);
      if (error || !data) fail('createSignedUrls', error);
      return new Map(data.flatMap((item) => (item.path && item.signedUrl && !item.error ? [[item.path, item.signedUrl] as const] : [])));
    },
  };
}
