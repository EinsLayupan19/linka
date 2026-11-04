import { z } from 'zod';
import { looksLikeSecretKey } from './secretKey';

export { looksLikeSecretKey };

// Vite gives "" for variables written as "NAME=" in .env, so treat that as "not set".
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const envSchema = z.object({
  VITE_API_URL: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .default('http://localhost:3000')
      .transform((url) => url.replace(/\/+$/, '')),
  ),
  VITE_SUPABASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine((key) => !looksLikeSecretKey(key), {
        message: 'is a SECRET key. Use the publishable (or anon) key in the frontend.',
      })
      .optional(),
  ),
});

export type FrontendEnv = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, unknown>): FrontendEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid frontend environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const env = parseEnv(import.meta.env);
