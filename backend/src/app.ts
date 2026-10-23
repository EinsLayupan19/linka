import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { DatabaseStatus, IceServer } from '@linka/shared';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { attachmentsRouter } from './routes/attachments.js';
import { callsRouter } from './routes/calls.js';
import { conversationsRouter } from './routes/conversations.js';
import { healthRouter } from './routes/health.js';
import { usersRouter } from './routes/users.js';
import { createAttachmentStore, type AttachmentStore } from './services/attachments.js';
import { createSupabaseTokenVerifier, type VerifyAccessToken } from './services/auth.js';
import { createCallStore, type CallStore } from './services/calls.js';
import { createConversationStore, type ConversationStore } from './services/conversations.js';
import { checkDatabase } from './services/health.js';
import { createMarkerStore, type MarkerStore } from './services/markers.js';
import { createMediaUrls } from './services/media.js';
import { createMessageStore, type MessageStore } from './services/messages.js';
import { createProfileStore, type ProfileStore } from './services/profiles.js';
import { createSupabaseStorage, type StorageGateway } from './services/storage.js';

export interface AppDependencies {
  checkDatabase: () => Promise<DatabaseStatus>;
  /** null when SUPABASE_URL is not configured: protected routes answer 503. */
  verifyAccessToken: VerifyAccessToken | null;
  /** null when DATABASE_URL is not configured (also for conversations). */
  profiles: ProfileStore | null;
  conversations: ConversationStore | null;
  messages: MessageStore | null;
  markers: MarkerStore | null;
  /** null without DATABASE_URL; uploads answer 503 without storage (SUPABASE_SECRET_KEY). */
  attachments: AttachmentStore | null;
  calls: CallStore | null;
  /** STUN/TURN servers handed to browsers for WebRTC (ICE_SERVERS). */
  iceServers: IceServer[];
}

/** Private Storage, only when the server-only secret key is configured. */
export const storage: StorageGateway | null =
  env.SUPABASE_URL && env.SUPABASE_SECRET_KEY ? createSupabaseStorage(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY) : null;

function defaultDependencies(): AppDependencies {
  const media = createMediaUrls(storage);
  return {
    checkDatabase,
    verifyAccessToken: env.SUPABASE_URL ? createSupabaseTokenVerifier(env.SUPABASE_URL) : null,
    profiles: db ? createProfileStore(db, media, storage) : null,
    conversations: db ? createConversationStore(db, media) : null,
    messages: db ? createMessageStore(db) : null,
    markers: db ? createMarkerStore(db) : null,
    attachments: db ? createAttachmentStore(db, storage) : null,
    calls: db ? createCallStore(db) : null,
    iceServers: env.ICE_SERVERS,
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
  app.use('/api/attachments', attachmentsRouter(deps));
  app.use('/api/calls', callsRouter(deps));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
