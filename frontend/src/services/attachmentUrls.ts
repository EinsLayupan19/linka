import { ATTACHMENT_URLS_MAX } from '@linka/shared';
import { getAttachmentUrls } from './attachments';

/**
 * Signed download URLs for attachments, cached until shortly before they expire. Requests made
 * in the same tick are batched into one API call (up to ATTACHMENT_URLS_MAX ids each), so a
 * page of messages with many images costs one request, not one per image.
 */

export interface SignedUrl {
  url: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A URL this close to expiring is fetched again instead of reused. */
export const URL_REFRESH_MARGIN_MS = 60_000;

const cache = new Map<string, SignedUrl>();
const waiting = new Map<string, { resolve: (url: SignedUrl | null) => void; reject: (error: unknown) => void }[]>();
let scheduled = false;

function fresh(entry: SignedUrl | undefined): entry is SignedUrl {
  return entry !== undefined && entry.expiresAt - Date.now() > URL_REFRESH_MARGIN_MS;
}

async function flush() {
  scheduled = false;
  const ids = [...waiting.keys()];
  for (let i = 0; i < ids.length; i += ATTACHMENT_URLS_MAX) {
    const batch = ids.slice(i, i + ATTACHMENT_URLS_MAX);
    const callbacks = batch.map((id) => {
      const list = waiting.get(id) ?? [];
      waiting.delete(id);
      return [id, list] as const;
    });
    try {
      const { urls } = await getAttachmentUrls(batch);
      const byId = new Map(urls.map((u) => [u.id, { url: u.url, expiresAt: new Date(u.expiresAt).getTime() }]));
      for (const [id, list] of callbacks) {
        const entry = byId.get(id) ?? null;
        if (entry) cache.set(id, entry);
        else cache.delete(id);
        // null: this user may not see it (or it no longer exists).
        for (const { resolve } of list) resolve(entry);
      }
    } catch (error) {
      for (const [, list] of callbacks) for (const { reject } of list) reject(error);
    }
  }
}

/** A usable URL for the attachment, or null if the caller may not see it. */
export function attachmentUrl(id: string, { force = false }: { force?: boolean } = {}): Promise<SignedUrl | null> {
  const cached = cache.get(id);
  if (!force && fresh(cached)) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const list = waiting.get(id) ?? [];
    list.push({ resolve, reject });
    waiting.set(id, list);
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => void flush(), 0);
    }
  });
}

/** Forget every URL (on sign-out, so the next user starts clean; and between tests). */
export function clearAttachmentUrls() {
  cache.clear();
}
