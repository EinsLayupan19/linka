import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './redirect';

describe('safeRedirectPath', () => {
  it('keeps same-site paths', () => {
    expect(safeRedirectPath('/profile?tab=edit')).toBe('/profile?tab=edit');
  });

  it.each(['//evil.example', 'https://evil.example', 'profile', undefined, 42])('falls back to / for %j', (value) => {
    expect(safeRedirectPath(value)).toBe('/');
  });
});
