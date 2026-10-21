import { sql } from 'drizzle-orm';
import type { DatabaseStatus } from '@linka/shared';
import { db } from '../db/client.js';

export async function checkDatabase(): Promise<DatabaseStatus> {
  if (!db) return 'not_configured';

  try {
    await db.execute(sql`select 1`);
    return 'connected';
  } catch (error) {
    // Log the reason server-side only. The client just sees "unreachable".
    console.error('Database health check failed:', error instanceof Error ? error.message : error);
    return 'unreachable';
  }
}
