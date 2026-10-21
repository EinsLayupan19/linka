import type { AuthUser } from '../services/auth.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the requireAuth middleware after the access token is verified. */
      auth?: AuthUser;
    }
  }
}

export {};
