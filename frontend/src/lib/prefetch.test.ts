import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPrefetched, loadWithPrefetch, PREFETCH_MAX_AGE_MS, prefetch } from './prefetch';

const never = () => new AbortController().signal;

describe('prefetch + loadWithPrefetch', () => {
  beforeEach(() => clearPrefetched());
  afterEach(() => vi.useRealTimers());

  it('hands the prefetched result to the first load instead of requesting again', async () => {
    const early = vi.fn(async () => 'early');
    const late = vi.fn(async () => 'late');

    prefetch('list', early);
    await expect(loadWithPrefetch('list', never(), late)).resolves.toBe('early');
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
  });

  it('uses a prefetched result only once: later loads (like a refetch after reconnecting) ask the server', async () => {
    prefetch('list', async () => 'early');
    await loadWithPrefetch('list', never(), async () => 'late');
    await expect(loadWithPrefetch('list', never(), async () => 'late')).resolves.toBe('late');
  });

  it('does not start the same prefetch twice while one is waiting to be used', () => {
    const load = vi.fn(async () => 'early');
    prefetch('list', load);
    prefetch('list', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads normally when nothing was prefetched', async () => {
    await expect(loadWithPrefetch('list', never(), async () => 'late')).resolves.toBe('late');
  });

  it('falls back to a normal load when the prefetch failed', async () => {
    prefetch('list', async () => {
      throw new Error('offline');
    });
    await expect(loadWithPrefetch('list', never(), async () => 'late')).resolves.toBe('late');
  });

  it('ignores a prefetched result that has been sitting unused for too long', async () => {
    vi.useFakeTimers();
    prefetch('list', async () => 'early');
    await vi.advanceTimersByTimeAsync(PREFETCH_MAX_AGE_MS + 1);
    await expect(loadWithPrefetch('list', never(), async () => 'late')).resolves.toBe('late');
  });

  it('rejects with an AbortError when the caller gives up, like fetch does', async () => {
    prefetch('list', () => new Promise<string>(() => undefined));
    const controller = new AbortController();
    const loading = loadWithPrefetch('list', controller.signal, async () => 'late');
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('forgets everything on clear (signing out)', async () => {
    prefetch('list', async () => "someone else's");
    clearPrefetched();
    await expect(loadWithPrefetch('list', never(), async () => 'mine')).resolves.toBe('mine');
  });
});
