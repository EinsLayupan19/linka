import { existsSync } from 'node:fs';

// Loads backend/.env into process.env for local development.
// On Render, variables come from the dashboard and there is no .env file.
// Variables that are already set are not overwritten.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
