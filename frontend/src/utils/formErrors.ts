import type { z } from 'zod';

/** First message per field, keyed by field name, for showing under form inputs. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.join('.');
    if (field) fields[field] ??= issue.message;
  }
  return fields;
}
