// Must be the first import: it fills process.env before config/env.ts reads it.
import './config/load-env.js';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase } from './db/client.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Linka API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  if (!env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. The API runs, but database features are unavailable.');
  }
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    closeDatabase()
      .catch((error: unknown) => console.error('Error while closing the database:', error))
      .finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
