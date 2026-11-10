import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockFetch } from '../test/fetch';
import { createSlowRequestTracker, SLOW_REQUEST_MS, warmUpApi } from './serverWake';

describe('createSlowRequestTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is not slow while requests finish quickly', () => {
    const tracker = createSlowRequestTracker();
    const done = tracker.start();
    vi.advanceTimersByTime(SLOW_REQUEST_MS - 1);
    done();
    vi.advanceTimersByTime(SLOW_REQUEST_MS);
    expect(tracker.isSlow()).toBe(false);
  });

  it('becomes slow once a request has been waiting for the threshold, and recovers when it ends', () => {
    const tracker = createSlowRequestTracker();
    const changes: boolean[] = [];
    tracker.subscribe(() => changes.push(tracker.isSlow()));

    const done = tracker.start();
    vi.advanceTimersByTime(SLOW_REQUEST_MS);
    expect(tracker.isSlow()).toBe(true);
    done();
    expect(tracker.isSlow()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('stays slow until every slow request has ended', () => {
    const tracker = createSlowRequestTracker();
    const first = tracker.start();
    const second = tracker.start();
    vi.advanceTimersByTime(SLOW_REQUEST_MS);

    first();
    expect(tracker.isSlow()).toBe(true);
    second();
    expect(tracker.isSlow()).toBe(false);
  });

  it('ignores a request ended twice', () => {
    const tracker = createSlowRequestTracker();
    const first = tracker.start();
    const second = tracker.start();
    vi.advanceTimersByTime(SLOW_REQUEST_MS);
    first();
    first();
    expect(tracker.isSlow()).toBe(true);
    second();
    expect(tracker.isSlow()).toBe(false);
  });

  it('stops notifying after unsubscribe', () => {
    const tracker = createSlowRequestTracker();
    const listener = vi.fn();
    tracker.subscribe(listener)();
    tracker.start();
    vi.advanceTimersByTime(SLOW_REQUEST_MS);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('warmUpApi', () => {
  it('pings the public health check without credentials, so a sleeping server starts waking up', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', database: 'connected' }));

    await warmUpApi();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/health');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('bypasses the HTTP cache, so the status page health check does not queue behind it', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', database: 'connected' }));

    await warmUpApi();

    expect(fetchMock.mock.calls[0]![1]?.cache).toBe('no-store');
  });

  it('never throws: it is only a head start', async () => {
    mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(warmUpApi()).resolves.toBeUndefined();
  });
});
