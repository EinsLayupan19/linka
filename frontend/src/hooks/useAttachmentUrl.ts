import { useCallback, useEffect, useState } from 'react';
import { attachmentUrl, URL_REFRESH_MARGIN_MS } from '../services/attachmentUrls';

export type AttachmentUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  /** The caller may not see it, or it no longer exists. */
  | { status: 'missing' }
  | { status: 'error' };

/**
 * A signed URL for one attachment, kept fresh while the component is mounted (fetched again
 * shortly before it expires, so links keep working in a conversation left open).
 * `reload` fetches a new one, e.g. after an image failed to load.
 */
export function useAttachmentUrl(attachmentId: string) {
  const [state, setState] = useState<AttachmentUrlState>({ status: 'loading' });
  const [request, setRequest] = useState({ force: false, n: 0 });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    attachmentUrl(attachmentId, { force: request.force }).then(
      (signed) => {
        if (!active) return;
        if (!signed) {
          setState({ status: 'missing' });
          return;
        }
        setState({ status: 'ready', url: signed.url });
        const refreshIn = signed.expiresAt - Date.now() - URL_REFRESH_MARGIN_MS;
        timer = setTimeout(() => setRequest((r) => ({ force: false, n: r.n + 1 })), Math.max(refreshIn, 1000));
      },
      () => {
        if (active) setState({ status: 'error' });
      },
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [attachmentId, request]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setRequest((r) => ({ force: true, n: r.n + 1 }));
  }, []);

  return { state, reload };
}
