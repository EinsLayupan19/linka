import { useEffect } from 'react';

export const APP_NAME = 'Linka';
export const TITLE_SUFFIX = ` · ${APP_NAME}`;

/**
 * Names the page in the browser tab (and history, and for screen readers: see PageAnnouncer),
 * e.g. "Weekend trip · Linka". Nothing happens while `title` is not known yet.
 */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    document.title = `${title}${TITLE_SUFFIX}`;
    return () => {
      document.title = APP_NAME;
    };
  }, [title]);
}
