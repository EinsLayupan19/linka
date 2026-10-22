import { z } from 'zod';

// Empty strings ("DATABASE_URL=") count as "not set".
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    CORS_ORIGIN: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url()).min(1)),
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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
    }
  });

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
