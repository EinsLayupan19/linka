import { useSyncExternalStore } from 'react';
import { slowRequests, type SlowRequestTracker } from '../../lib/serverWake';

/**
 * Says why the app is waiting when the API is slow to answer (the free host sleeps when nobody
 * uses it and takes up to a minute to wake). Floats under the header so no layout moves, sits
 * below the call panel, and disappears as soon as the server answers. No animation: it is a
 * status, not an event.
 */
export function ServerWakeNotice({ tracker = slowRequests }: { tracker?: SlowRequestTracker }) {
  const slow = useSyncExternalStore(tracker.subscribe, tracker.isSlow, tracker.isSlow);
  if (!slow) return null;
  return (
    <p
      role="status"
      className="fixed inset-x-4 top-16 z-40 mx-auto max-w-md rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink shadow-lg shadow-ink/10"
    >
      <span className="font-medium">Waking up the server.</span>{' '}
      <span className="text-ink-muted">After a quiet period, the first load can take up to a minute.</span>
    </p>
  );
}
