import { z } from 'zod';

/**
 * - connected: the API reached PostgreSQL.
 * - unreachable: DATABASE_URL is set but the query failed or timed out.
 * - not_configured: DATABASE_URL is not set yet.
 */
export const databaseStatusSchema = z.enum(['connected', 'unreachable', 'not_configured']);

export type DatabaseStatus = z.infer<typeof databaseStatusSchema>;

export const healthResponseSchema = z.object({
  /** "ok" only when every dependency is healthy. */
  status: z.enum(['ok', 'degraded']),
  database: databaseStatusSchema,
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
