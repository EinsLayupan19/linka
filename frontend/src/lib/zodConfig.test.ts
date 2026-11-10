import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import './zodConfig';

describe('Zod configuration', () => {
  // Zod otherwise probes for code generation with Function(''), which the Content-Security-Policy
  // blocks: harmless (Zod falls back), but the browser logs a CSP violation on every page load.
  it('never tries to generate code at runtime', () => {
    expect(z.config().jitless).toBe(true);
  });
});
