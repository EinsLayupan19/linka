import { Router } from 'express';
import type { DatabaseStatus, HealthResponse } from '@linka/shared';

export function healthRouter(checkDatabase: () => Promise<DatabaseStatus>): Router {
  const router = Router();

  // Always 200 while the API process is up, so a database outage does not make
  // Render restart a healthy server. The body says whether dependencies are healthy.
  router.get('/', async (_req, res) => {
    const database = await checkDatabase();
    const body: HealthResponse = {
      status: database === 'connected' ? 'ok' : 'degraded',
      database,
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  return router;
}
