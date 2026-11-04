import { describe, expect, it } from 'vitest';
import { createRateLimiter, RATE_LIMITS } from './rateLimit.js';

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe('createRateLimiter', () => {
  it('allows up to the limit in a window, then says how long to wait', () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 }, c.now);
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a')]).toEqual([0, 0, 0]);
    c.advance(15_000);
    expect(limiter.hit('a')).toBe(45_000);
  });

  it('starts a fresh window once the old one is over', () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, c.now);
    limiter.hit('a');
    expect(limiter.hit('a')).toBeGreaterThan(0);
    c.advance(1000);
    expect(limiter.hit('a')).toBe(0);
  });

  it('counts every key on its own', () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, c.now);
    expect(limiter.hit('user:a')).toBe(0);
    expect(limiter.hit('user:b')).toBe(0);
    expect(limiter.hit('user:a')).toBeGreaterThan(0);
  });

  it('keeps refusing while over the limit, without extending the window', () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, c.now);
    limiter.hit('a');
    expect(limiter.hit('a')).toBe(1000);
    c.advance(400);
    expect(limiter.hit('a')).toBe(600);
  });
});

describe('RATE_LIMITS', () => {
  it('leaves normal use well inside the limits', () => {
    // A call heartbeat every 20 s, typing-paced search and chatting are far below these.
    expect(RATE_LIMITS.user.limit).toBeGreaterThanOrEqual(300);
    expect(RATE_LIMITS.sendMessage.limit).toBeGreaterThanOrEqual(60);
    expect(RATE_LIMITS.userSearch.limit).toBeGreaterThanOrEqual(30);
    for (const rule of Object.values(RATE_LIMITS)) expect(rule.windowMs).toBe(60_000);
  });
});
