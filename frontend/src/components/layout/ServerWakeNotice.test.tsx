import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlowRequestTracker, SLOW_REQUEST_MS } from '../../lib/serverWake';
import { ServerWakeNotice } from './ServerWakeNotice';

describe('ServerWakeNotice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing while requests are quick', () => {
    const tracker = createSlowRequestTracker();
    render(<ServerWakeNotice tracker={tracker} />);
    const done = tracker.start();
    act(() => vi.advanceTimersByTime(SLOW_REQUEST_MS - 1));
    done();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('explains a slow server politely, and goes away when it answers', () => {
    const tracker = createSlowRequestTracker();
    render(<ServerWakeNotice tracker={tracker} />);

    const done = tracker.start();
    act(() => vi.advanceTimersByTime(SLOW_REQUEST_MS));
    expect(screen.getByRole('status')).toHaveTextContent(/waking up the server/i);

    act(() => done());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
