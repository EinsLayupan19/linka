import type { Bucket, StorageGateway, StoredObject } from '../services/storage.js';

/**
 * In-memory stand-in for Supabase Storage. Tests "upload" with putObject (what a browser does
 * with a signed upload URL), and can make any operation fail to test error paths.
 */
export interface MemoryStorage extends StorageGateway {
  putObject(bucket: Bucket, path: string, bytes: Uint8Array, contentType: string): void;
  has(bucket: Bucket, path: string): boolean;
  paths(bucket: Bucket): string[];
  /** Upload URLs issued so far, by path. */
  uploadUrls: Map<string, string>;
  failNext(operation: keyof StorageGateway): void;
}

export function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const key = (bucket: Bucket, path: string) => `${bucket}/${path}`;
  const failing = new Set<keyof StorageGateway>();
  const uploadUrls = new Map<string, string>();

  const maybeFail = (operation: keyof StorageGateway) => {
    if (failing.delete(operation)) throw new Error(`storage ${operation} is down`);
  };

  return {
    uploadUrls,

    async createUploadUrl(bucket, path) {
      maybeFail('createUploadUrl');
      const url = `https://storage.test/upload/${bucket}/${path}?token=${Math.random().toString(36).slice(2)}`;
      uploadUrls.set(path, url);
      return { url, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) };
    },

    async inspect(bucket, path, headBytes): Promise<StoredObject | null> {
      maybeFail('inspect');
      const object = objects.get(key(bucket, path));
      if (!object) return null;
      return { sizeBytes: object.bytes.byteLength, contentType: object.contentType, head: object.bytes.slice(0, headBytes) };
    },

    async upload(bucket, path, body, contentType) {
      maybeFail('upload');
      if (objects.has(key(bucket, path))) throw new Error('already exists');
      objects.set(key(bucket, path), { bytes: body, contentType });
    },

    async remove(bucket, paths) {
      maybeFail('remove');
      for (const path of paths) objects.delete(key(bucket, path));
    },

    async signedUrls(bucket, paths, expiresInSeconds) {
      maybeFail('signedUrls');
      return new Map(
        paths
          .filter((path) => objects.has(key(bucket, path)))
          .map((path) => [path, `https://storage.test/sign/${bucket}/${path}?expires=${expiresInSeconds}`]),
      );
    },

    putObject(bucket, path, bytes, contentType) {
      objects.set(key(bucket, path), { bytes, contentType });
    },
    has: (bucket, path) => objects.has(key(bucket, path)),
    paths: (bucket) => [...objects.keys()].filter((k) => k.startsWith(`${bucket}/`)).map((k) => k.slice(bucket.length + 1)),
    failNext: (operation) => void failing.add(operation),
  };
}

/** Real file signatures, padded to a realistic size. */
export const sampleFiles = {
  png: () => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 2048),
  jpeg: () => bytes([0xff, 0xd8, 0xff, 0xe0], 4096),
  pdf: () => bytes([...'%PDF-1.7'].map((c) => c.charCodeAt(0)), 3000),
  text: () => new TextEncoder().encode('Meeting notes\nBring snacks.\n'),
  /** An executable pretending to be a PNG. */
  exe: () => bytes([0x4d, 0x5a, 0x90, 0x00], 2048),
};

function bytes(prefix: number[], size: number): Uint8Array {
  const data = new Uint8Array(size).fill(0x41);
  data.set(prefix, 0);
  return data;
}
