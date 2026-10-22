import { useEffect } from 'react';
import { LAST_SEEN_REPORT_INTERVAL_MS } from '@linka/shared';
import { reportSeen } from '../services/receipts';

/**
 * Keeps "Last seen" roughly current without a presence heartbeat: one report on start, one
 * every few minutes while the tab is visible, and one when it is hidden or closed. The server
 * ignores reports less than a minute apart. Live "Online" comes from Realtime Presence instead.
 */
export function useActivityReporter() {
  useEffect(() => {
    const report = (keepalive = false) => void reportSeen({ keepalive }).catch(() => undefined);
    report();

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') report();
    }, LAST_SEEN_REPORT_INTERVAL_MS);
    const onVisibility = () => report(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
