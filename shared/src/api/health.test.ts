import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';
import { apiErrorResponseSchema } from './errors.js';

describe('healthResponseSchema', () => {
  it('accepts a healthy response', () => {
    expect(healthResponseSchema.parse({ status: 'ok', database: 'connected' })).toEqual({
      status: 'ok',
      database: 'connected',
    });
  });

  it('rejects an unknown database status', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', database: 'maybe' }).success).toBe(false);
  });
});

describe('apiErrorResponseSchema', () => {
  it('requires a code and a message', () => {
    expect(apiErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND' } }).success).toBe(false);
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'Not found' } }).success,
    ).toBe(true);
  });
});
