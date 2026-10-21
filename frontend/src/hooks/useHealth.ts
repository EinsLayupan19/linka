import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '@linka/shared';
import { toApiError, type ApiError } from '../lib/api';
import { getHealth } from '../services/health';

export type HealthState =
  | { status: 'loading' }
  | { status: 'success'; data: HealthResponse }
  | { status: 'error'; error: ApiError };

export function useHealth() {
  const [state, setState] = useState<HealthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    getHealth(controller.signal).then(
      (data) => setState({ status: 'success', data }),
      (error: unknown) => {
        // A newer check (or unmount) replaced this one; its result no longer matters.
        if (controller.signal.aborted) return;
        setState({ status: 'error', error: toApiError(error) });
      },
    );

    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return { state, retry };
}
