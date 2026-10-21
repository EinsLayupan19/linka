# Development status

| Phase | Name                                   | Status      |
| ----- | -------------------------------------- | ----------- |
| 1     | Foundation                             | Complete    |
| 2     | Authentication & user foundation       | In review   |
| 3     | Database & conversation foundation     | Not started |
| 4     | Realtime messaging                     | Not started |
| 5     | Read, delivery, presence & typing      | Not started |
| 6     | Media & file sharing                   | Not started |
| 7     | Voice calls                            | Not started |
| 8     | Video calls                            | Not started |
| 9     | Polish, security & scalability         | Not started |
| 10    | Production preparation & deployment    | Not started |

## Phase 1: Foundation

- npm workspaces: `shared`, `backend`, `frontend`
- Shared Zod schemas: API error shape, health response
- Express API: env validation, helmet, CORS, JSON body limit, 404 + error handler, `GET /api/health`
- Drizzle + postgres client and config
- React app shell, error boundary, 404 page, status page (API / database / Supabase config)
- Supabase browser client (lazy, rejects secret keys)
- ESLint, Vitest, React Testing Library, Supertest

## Phase 2: Authentication & user foundation

Done:

- Supabase Auth in the browser: register, login, logout, password reset, session persistence and
  refresh, auth state (`AuthProvider`), protected routes
- API token verification (`requireAuth`, JWKS via `jose`) and authenticated API requests
- `profiles` table with constraints and deny-by-default RLS (migration `0000_profiles`)
- `GET/POST/PATCH /api/users/me`, Zod-validated, scoped to the token's user
- Pages: login, register, forgot password, reset password, profile setup, profile
- Tests: shared validation, token verification, RLS and constraints on real Postgres (PGlite),
  profile store, API routes, auth state, route guards, auth and profile pages

Not verifiable until a Supabase project exists:

- Real sign-up, confirmation email, login, refresh and reset against Supabase Auth
- Token verification against the project's real JWKS endpoint
- Applying the migration to the hosted database and RLS there (tested on PGlite only)

### Supabase setup (dashboard)

1. **Create the project** (hosted). Then copy:
   - *Project Settings > API Keys*: the **publishable** key (or legacy `anon` key) ->
     `frontend/.env` `VITE_SUPABASE_PUBLISHABLE_KEY`. Never the secret / `service_role` key.
   - Project URL (`https://<ref>.supabase.co`) -> `frontend/.env` `VITE_SUPABASE_URL` **and**
     `backend/.env` `SUPABASE_URL`.
   - *Connect > Session pooler* connection string -> `backend/.env` `DATABASE_URL`.
2. **JWT signing keys.** *Project Settings > JWT Keys*: the current key must be an asymmetric key
   (ECC P-256 or RSA), which is the default for new projects. If the project still uses the legacy
   HS256 shared secret, migrate to signing keys there. The API only accepts ES256/RS256 tokens.
3. **Auth URL configuration.** *Authentication > URL Configuration*:
   - Site URL: `http://localhost:5173` (production URL later).
   - Redirect URLs: add `http://localhost:5173/**`.
4. **Email confirmation.** *Authentication > Sign In / Providers > Email*: keep "Confirm email" on.
5. **Password length.** Same page: set the minimum password length to **8** to match the app.
6. **Apply the migration:** `cd backend && npm run db:migrate`.

Supabase's built-in email service is heavily rate limited and meant for testing; configure custom
SMTP (*Authentication > Emails > SMTP Settings*) before real users sign up.

## Decisions

| Decision | Choice |
| --- | --- |
| Shared code | `shared/` workspace package (`@linka/shared`) |
| Migrations | Drizzle owns all migrations, including RLS / custom SQL |
| Env files | Separate `frontend/.env.example` and `backend/.env.example` |
| Database | Hosted Supabase project, no local database |
| Auth | Browser talks to Supabase Auth directly; API verifies tokens (no `/api/auth/*` proxy) |
| Token verification | Local JWT verification against the project's JWKS (ES256/RS256 only) |
| Profile creation | Onboarding step after first login (`POST /api/users/me`), not at sign-up |
| Profile writes | API only; RLS has a select-own policy and no write policies |
| Profile visibility | Own profile only in Phase 2; widened in Phase 3 / discovery |
| Username | Unique, lowercase `a-z 0-9 _`, 3-20 chars; not editable yet |
| User discovery | Username-based (not email). Designed in the relevant phase |
| Profile pictures | Media/storage phase (6) |
| Group roles | `owner`, `admin`, `member`. Defined in Phase 3 |
| Realtime messaging | Postgres Changes vs Broadcast tradeoff presented before Phase 4 |
| TURN | Documented limitation in Phase 7; hosted provider only when needed |

## Known issues / notes

- `npm audit` reports 4 moderate findings, all one esbuild dev-server advisory (GHSA-67mh-4wv8-2f99)
  pulled in through `drizzle-kit`'s `@esbuild-kit` loader. drizzle-kit is a dev-only CLI and does not
  run an esbuild dev server, so the advisory does not apply. `npm audit fix --force` would downgrade
  drizzle-kit to 0.18, so it is intentionally not applied.
- TypeScript is pinned to 6.0.x because typescript-eslint does not support TypeScript 7 yet.
- The frontend bundle is ~587 kB (168 kB gzipped), mostly React and supabase-js; Vite warns above
  500 kB. Code splitting is part of the Phase 9 performance audit.
- Access tokens stay valid until they expire (default 1 hour) even after logout; logout revokes the
  refresh token.
