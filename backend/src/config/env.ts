import { z } from 'zod';
import { iceServerSchema } from '@linka/shared';

// Empty strings ("DATABASE_URL=") count as "not set".
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** A public STUN server: lets browsers learn their public address. Carries no media. */
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const parseJson = (value: unknown) => {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value; // fails validation below with a clear message (the value is never printed)
  }
};

/** The Vite dev server. Only a default outside production: there it must be set explicitly. */
const DEV_CORS_ORIGIN = 'http://localhost:5173';

/**
 * One allowed origin, e.g. https://linka.example.com. Browsers send the Origin header without a
 * trailing slash or path, so a pasted "https://linka.example.com/" is normalized, and anything with
 * a real path (which could never match) is refused.
 */
const originSchema = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return true; // already reported by z.url()
    const url = new URL(value);
    return url.pathname === '/' && !url.search && !url.hash && !url.username;
  }, 'must be an origin only, like https://linka.example.com (no path)')
  .transform((value) => new URL(value).origin);

const isHttps = (value: string) => value.startsWith('https://');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    // Comma-separated. Not set: the dev server in development; an error in production.
    CORS_ORIGIN: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .transform((value) =>
          value
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
        )
        .pipe(z.array(originSchema).min(1))
        .optional(),
    ),
    DATABASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// connection string')
        .optional(),
    ),
    // Used to verify Supabase access tokens (public signing keys, no secret needed).
    SUPABASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .url()
        .transform((url) => url.replace(/\/+$/, ''))
        .optional(),
    ),
    // Server-only Supabase secret key (sb_secret_... or the legacy service_role key). Used only
    // for Storage: issuing signed upload/download URLs and checking uploaded files. Never sent
    // to the browser.
    SUPABASE_SECRET_KEY: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .min(20, 'looks too short to be a Supabase secret key')
        .refine((key) => !key.startsWith('sb_publishable_'), 'is the publishable key; use the secret key')
        .optional(),
    ),
    // WebRTC STUN/TURN servers as JSON, e.g. [{"urls":"stun:stun.example.com:3478"}]. TURN
    // credentials put here are sent to signed-in browsers (that is how TURN works); prefer a
    // provider's short-lived credentials when TURN is added.
    // How many reverse proxies sit in front of the API (Render: 1). Express then takes the client's
    // IP from X-Forwarded-For past exactly that many hops; rate limits without a valid sign-in are
    // per IP. 0 trusts nobody (local development): the header is ignored and cannot be spoofed.
    TRUST_PROXY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(10).default(0)),
    ICE_SERVERS: z.preprocess(
      parseJson,
      z.array(iceServerSchema, 'must be a JSON array of ICE servers').min(1).default(DEFAULT_ICE_SERVERS),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['CORS_ORIGIN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
    }
    // Real sites are served over HTTPS; an http origin here is almost always a copy mistake.
    if (env.CORS_ORIGIN && !env.CORS_ORIGIN.every(isHttps)) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: 'must use https:// in production' });
    }
    if (env.SUPABASE_URL && !isHttps(env.SUPABASE_URL)) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'must use https:// in production' });
    }
  })
  .transform((env) => ({ ...env, CORS_ORIGIN: env.CORS_ORIGIN ?? [DEV_CORS_ORIGIN] }));

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Only variable names and rules are printed, never the values.
    throw new Error(`Invalid backend environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
