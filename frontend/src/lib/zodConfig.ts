import { z } from 'zod';

/**
 * Imported first by main.tsx, before any schema is used. Zod otherwise probes for runtime code
 * generation with Function(''), which the Content-Security-Policy blocks. Zod would fall back
 * safely, but the browser would log a CSP violation on every page load and hide real ones.
 */
z.config({ jitless: true });
