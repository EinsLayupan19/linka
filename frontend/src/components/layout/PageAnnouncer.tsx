import { useEffect, useState } from 'react';
import { APP_NAME, TITLE_SUFFIX } from '../../hooks/useDocumentTitle';

/**
 * Says the page's name to screen readers when it changes. A full page load does this by itself;
 * moving between pages inside the app does not, so without this, blind users would not hear that
 * a new page opened. It follows document.title (set by each page with useDocumentTitle).
 */
export function PageAnnouncer() {
  const [message, setMessage] = useState('');

  useEffect(() => {
    // Watch <head>: the <title> element may not exist until the first page sets a title.
    const observer = new MutationObserver(() => {
      const title = document.title;
      if (title && title !== APP_NAME) setMessage(title.endsWith(TITLE_SUFFIX) ? title.slice(0, -TITLE_SUFFIX.length) : title);
    });
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <p aria-live="polite" aria-atomic="true" data-testid="page-announcer" className="sr-only">
      {message}
    </p>
  );
}
