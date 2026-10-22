import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { DatabaseStatus } from '@linka/shared';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { conversationsRouter } from './routes/conversations.js';
import { healthRouter } from './routes/health.js';
import { usersRouter } from './routes/users.js';
import { createSupabaseTokenVerifier, type VerifyAccessToken } from './services/auth.js';
import { createConversationStore, type ConversationStore } from './services/conversations.js';
import { checkDatabase } from './services/health.js';
import { createMarkerStore, type MarkerStore } from './services/markers.js';
import { createMessageStore, type MessageStore } from './services/messages.js';
import { createProfileStore, type ProfileStore } from './services/profiles.js';

export interface AppDependencies {
  checkDatabase: () => Promise<DatabaseStatus>;
  /** null when SUPABASE_URL is not configured: protected routes answer 503. */
  verifyAccessToken: VerifyAccessToken | null;
  /** null when DATABASE_URL is not configured (also for conversations). */
  profiles: ProfileStore | null;
  conversations: ConversationStore | null;
  messages: MessageStore | null;
  markers: MarkerStore | null;
}

function defaultDependencies(): AppDependencies {
  return {
    checkDatabase,
    verifyAccessToken: env.SUPABASE_URL ? createSupabaseTokenVerifier(env.SUPABASE_URL) : null,
    profiles: db ? createProfileStore(db) : null,
    conversations: db ? createConversationStore(db) : null,
    messages: db ? createMessageStore(db) : null,
    markers: db ? createMarkerStore(db) : null,
  };
}

/**
 * Builds the Express app without starting a server, so tests can call it directly.
 * Any dependency can be swapped in tests (for example, a fake database check).
 */
export function createApp(overrides: Partial<AppDependencies> = {}): Express {
  const deps: AppDependencies = { ...defaultDependencies(), ...overrides };
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter(deps.checkDatabase));
  app.use('/api/users', usersRouter(deps));
  app.use('/api/conversations', conversationsRouter(deps));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
