import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Loads backend/.env into process.env for local development.
// On Render, variables come from the dashboard and there is no .env file.
// Variables that are already set are not overwritten.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
