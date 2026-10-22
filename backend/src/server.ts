// Must be the first import: it fills process.env before config/env.ts reads it.
import './config/load-env.js';
import { createApp, storage } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, db } from './db/client.js';
import { createAttachmentStore } from './services/attachments.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Linka API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  if (!env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. The API runs, but database features are unavailable.');
  }
  if (!storage) {
    console.warn('SUPABASE_SECRET_KEY is not set. File uploads and profile pictures are unavailable.');
  }
});

/**
 * Removes uploads that were never sent (older than UNATTACHED_UPLOAD_TTL_HOURS), so abandoned or
 * failed uploads do not stay in Storage forever. Rows are claimed before files are deleted, so
 * running this on several instances at once is safe.
 */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const sweeper = db && storage ? createAttachmentStore(db, storage) : null;
async function sweep() {
  if (!sweeper) return;
  try {
    let removed = 0;
    // Work through a backlog in bounded batches.
    for (let batch = await sweeper.sweepUnattached(); batch > 0; batch = await sweeper.sweepUnattached()) {
      removed += batch;
    }
    if (removed > 0) console.log(`Removed ${removed} unsent upload(s).`);
  } catch (error) {
    console.error('Upload cleanup failed:', error instanceof Error ? error.message : error);
  }
}
const firstSweep = setTimeout(sweep, 60_000);
const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
firstSweep.unref();
sweepTimer.unref();

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  clearTimeout(firstSweep);
  clearInterval(sweepTimer);
  server.close(() => {
    closeDatabase()
      .catch((error: unknown) => console.error('Error while closing the database:', error))
      .finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
