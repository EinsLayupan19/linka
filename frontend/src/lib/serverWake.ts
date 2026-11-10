import { env } from './env';

/**
 * The API runs on a free host that sleeps after a quiet period and takes up to about a minute to
 * wake. Two small things make that bearable:
 *
 * - warmUpApi(): pinged once when the app starts, so the server is already waking while the page
 *   restores the session (or while someone types their password on the login page)
 * - a slow-request tracker: when any API request has been waiting longer than SLOW_REQUEST_MS,
 *   the app says why (see ServerWakeNotice) instead of showing skeletons with no explanation
 */
export const SLOW_REQUEST_MS = 4000;

export interface SlowRequestTracker {
  /** Call when a request starts; call the returned function when it ends (in any way). */
  start(): () => void;
  /** Whether some request has been waiting for at least SLOW_REQUEST_MS. */
  isSlow(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createSlowRequestTracker(thresholdMs = SLOW_REQUEST_MS): SlowRequestTracker {
  let slowCount = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    start() {
      let ended = false;
      let slow = false;
      const timer = setTimeout(() => {
        slow = true;
        slowCount += 1;
        if (slowCount === 1) notify();
      }, thresholdMs);

      return () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (!slow) return;
        slowCount -= 1;
        if (slowCount === 0) notify();
      };
    },
    isSlow: () => slowCount > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's tracker: every apiRequest reports to it. */
export const slowRequests = createSlowRequestTracker();

/**
 * Starts waking a sleeping API. Public, unauthenticated and cheap; the answer is not needed and
 * a failure changes nothing (the real requests report their own errors).
 */
export async function warmUpApi(): Promise<void> {
  try {
    // no-store: browsers make a second identical GET wait for a cacheable first one, which would
    // hold the status page's own health check behind this one.
    await fetch(`${env.VITE_API_URL}/api/health`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch {
    // Offline or unreachable: the real requests will say so.
  }
}
