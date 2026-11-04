import type { Request, RequestHandler } from 'express';
import { ErrorCode } from '@linka/shared';
import { AppError } from '../utils/AppError.js';

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;

/**
 * Limits per minute. Signed-in requests count per user (the id from the verified token), so
 * everyone behind one office or campus network keeps their own allowance; only requests without
 * a valid token count per IP address. Chosen well above what the web client does in normal use
 * (it debounces search, batches receipts and sends a call heartbeat every 20 s).
 */
export const RATE_LIMITS = {
  /** Requests with a missing, expired or invalid access token, per IP. */
  unauthenticated: { limit: 60, windowMs: MINUTE },
  /** The public health check, per IP (uptime monitors poll it; it touches the database). */
  health: { limit: 120, windowMs: MINUTE },
  /** Everything one signed-in user does, together. */
  user: { limit: 600, windowMs: MINUTE },
  sendMessage: { limit: 120, windowMs: MINUTE },
  userSearch: { limit: 60, windowMs: MINUTE },
  createConversation: { limit: 20, windowMs: MINUTE },
  /** Renaming groups, adding and removing people, changing roles. */
  manageGroup: { limit: 60, windowMs: MINUTE },
  startCall: { limit: 10, windowMs: MINUTE },
  /** Starting attachment uploads and setting a profile picture. */
  uploads: { limit: 60, windowMs: MINUTE },
} satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;
export type RateLimitConfig = Record<RateLimitName, RateLimitRule>;

export interface RateLimiter {
  /** Counts one request for `key`. Returns 0 if allowed, otherwise how many ms until it would be. */
  hit(key: string): number;
}

/**
 * A fixed-window counter per key, kept in this process's memory. Windows that ended are dropped
 * as new ones start, so memory stays proportional to the keys seen in the last window.
 *
 * With several API instances each counts separately (a client could get the limit once per
 * instance); a shared store such as Redis would be needed then (see ARCHITECTURE.md).
 */
export function createRateLimiter(rule: RateLimitRule, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();

  return {
    hit(key) {
      const time = now();
      if (time - lastSweep >= rule.windowMs) {
        for (const [k, window] of windows) if (time - window.start >= rule.windowMs) windows.delete(k);
        lastSweep = time;
      }
      const window = windows.get(key);
      if (!window || time - window.start >= rule.windowMs) {
        windows.set(key, { start: time, count: 1 });
        return 0;
      }
      window.count += 1;
      return window.count > rule.limit ? window.start + rule.windowMs - time : 0;
    },
  };
}

/** Throws the API's 429, with Retry-After in whole seconds, when `waitMs` is above 0. */
export function refuseIfLimited(waitMs: number, setHeader: (name: string, value: string) => void) {
  if (waitMs <= 0) return;
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  setHeader('Retry-After', String(seconds));
  throw new AppError(429, ErrorCode.RateLimited, `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`);
}

/**
 * The client's IP as Express sees it. Behind a proxy (Render), Express takes it from
 * X-Forwarded-For only as far as the `trust proxy` setting allows (TRUST_PROXY), so a client cannot
 * pick its own bucket by sending that header.
 */
export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export type ApiRateLimits = Record<Exclude<RateLimitName, 'unauthenticated'>, RequestHandler> & {
  /** For requireAuth: counts a request that had no valid token (per IP). */
  unauthenticated: RateLimiter;
};

/** One limiter per rule, as middleware: per IP before sign-in, per user after it. */
export function createRateLimits(config: RateLimitConfig = RATE_LIMITS): ApiRateLimits {
  // Used after requireAuth, so req.auth is the verified user; the IP is only a fallback.
  const perUser = (rule: RateLimitRule): RequestHandler => {
    const limiter = createRateLimiter(rule);
    return (req, res, next) => {
      const key = req.auth ? `user:${req.auth.userId}` : `ip:${clientIp(req)}`;
      refuseIfLimited(limiter.hit(key), (name, value) => res.set(name, value));
      next();
    };
  };
  const perIp = (rule: RateLimitRule): RequestHandler => {
    const limiter = createRateLimiter(rule);
    return (req, res, next) => {
      refuseIfLimited(limiter.hit(clientIp(req)), (name, value) => res.set(name, value));
      next();
    };
  };

  return {
    unauthenticated: createRateLimiter(config.unauthenticated),
    health: perIp(config.health),
    user: perUser(config.user),
    sendMessage: perUser(config.sendMessage),
    userSearch: perUser(config.userSearch),
    createConversation: perUser(config.createConversation),
    manageGroup: perUser(config.manageGroup),
    startCall: perUser(config.startCall),
    uploads: perUser(config.uploads),
  };
}
