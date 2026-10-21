# Architecture

Linka is a **modular monolith**: one frontend, one API, one database, with clear boundaries between
modules so parts can be split out later if real load requires it. See [PLAN.md](../PLAN.md) for the
full plan.

## Packages

```text
@linka/frontend ──┐
                  ├──> @linka/shared (Zod schemas + types)
@linka/backend  ──┘
```

`@linka/shared` holds the contracts between frontend and backend (request/response schemas, error
codes). It is compiled to `shared/dist` with `tsc`; the root scripts always build it first.

## Request flow

```text
React component
  -> hook            (state: loading / success / error)
  -> service         (one function per API operation)
  -> lib/api.ts      (fetch + response validation with Zod, one ApiError type)
  -> Express route   (thin: parse input, call service)
  -> service         (business logic)
  -> db (Drizzle)    -> PostgreSQL
```

Example in Phase 1: `Home` -> `useHealth()` -> `services/health.ts` -> `GET /api/health` ->
`routes/health.ts` -> `services/health.ts` (`select 1`).

## Authentication (Phase 2)

```text
Browser ──(email + password)──> Supabase Auth          (sign up, log in, reset, refresh)
Browser ──(Authorization: Bearer <access token>)──> Express API
Express ──(verify signature with the project's PUBLIC keys, cached)──> JWKS
```

- The browser talks to Supabase Auth directly (`frontend/src/services/auth.ts`). There are no
  `/api/auth/*` proxy endpoints.
- supabase-js keeps the session in `localStorage` and refreshes the access token before it expires.
  `AuthProvider` mirrors its auth events (`INITIAL_SESSION`, `SIGNED_IN`, `TOKEN_REFRESHED`,
  `SIGNED_OUT`, `PASSWORD_RECOVERY`) into React state.
- `lib/api.ts` attaches the current access token to requests made with `{ auth: true }`.
- The API's `requireAuth` middleware verifies every token with `jose`: signature (ES256/RS256 via
  `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`), issuer, audience `authenticated`, expiry,
  `role = authenticated`, not anonymous, and a UUID subject. **The user ID always comes from the
  verified token**, never from the request body or URL.
- Key fetch failures answer 503 (try again), invalid tokens answer 401.

**Routes (frontend).** Signed-out: `/login`, `/register`, `/forgot-password`. From the reset email:
`/reset-password`. Signed-in: `/onboarding` (choose a username), `/profile`. Public: `/status`, 404.
`/` redirects to `/profile` until conversations exist.

**Profiles.** After the first login, users without a profile are sent to `/onboarding` to pick a
username and display name (`POST /api/users/me`). Usernames are chosen there rather than at sign-up
because, with email confirmation on, sign-up returns no session, and a taken username would otherwise
surface as a confusing sign-up failure.

**Privacy model (Phase 2).** A user can read and change only their own profile. Profiles of other
users are not visible yet; this is widened deliberately later (conversation members in Phase 3,
username-based discovery when contacts are built). Email addresses stay in Supabase `auth.users` and
are never copied into `profiles`.

**Known limitation.** Access tokens are stateless: after logout or account deletion, an already
issued access token stays valid until it expires (Supabase default: 1 hour). Logout revokes the
refresh token, so it cannot be renewed.

## Backend (`backend/src`)

| Folder / file          | Responsibility                                                      |
| ---------------------- | ------------------------------------------------------------------- |
| `server.ts`            | Starts the HTTP server, graceful shutdown                           |
| `app.ts`               | Builds the Express app (no `listen`), so tests can use it directly |
| `config/`              | Loads and validates environment variables with Zod (fails fast)     |
| `middleware/`          | Cross-cutting concerns: `requireAuth`, 404 handler, error handler   |
| `routes/`              | URL -> handler mapping. Kept thin (`health`, `users`)               |
| `services/`            | Business logic (`auth` token verification, `profiles`, `health`)    |
| `validation/`          | `parseBody`: shared Zod schema -> parsed data or 400 with field errors |
| `db/`                  | Drizzle client, schema and migrations                               |
| `utils/`               | Small helpers (`AppError`)                                          |
| `test/`                | Test-only helpers: in-memory Postgres (PGlite), signed test tokens  |

`controllers/` from PLAN.md is created if route handlers grow beyond a few lines.

**API (Phase 2).** All require `Authorization: Bearer <access token>` and act on the caller only.

| Method | Path            | Body                          | Result                                    |
| ------ | --------------- | ----------------------------- | ----------------------------------------- |
| GET    | `/api/users/me` |                               | 200 profile, 404 `PROFILE_NOT_FOUND`      |
| POST   | `/api/users/me` | `{ username, displayName }`   | 201 profile, 409 `USERNAME_TAKEN` / `PROFILE_EXISTS` |
| PATCH  | `/api/users/me` | `{ displayName }`             | 200 profile, 404 `PROFILE_NOT_FOUND`      |

Bodies are strict: unknown fields (for example `id`) are rejected with 400 `VALIDATION_FAILED`.
Responses are `Cache-Control: private, no-store`.

**Errors.** Throw `AppError(status, code, message)` for errors the client may see. Anything else
becomes a generic `500 INTERNAL_ERROR`; the details are logged on the server only. All errors use the
shared shape `{ "error": { "code": "...", "message": "..." } }`.

**Security baseline (Phase 1).** `helmet` security headers, CORS restricted to `CORS_ORIGIN`, JSON body
limit of 100 kB, no stack traces in responses. Token verification arrived in Phase 2; rate limiting
is part of the Phase 9 audit (Supabase Auth applies its own rate limits to sign-in and emails).

## Frontend (`frontend/src`)

| Folder       | Responsibility                                              |
| ------------ | ----------------------------------------------------------- |
| `pages/`     | Route-level screens                                         |
| `components/`| `ui/` primitives, `layout/` shell and error boundary, feature folders |
| `hooks/`     | State + side effects for components                         |
| `services/`  | API / Supabase calls, one function per operation            |
| `lib/`       | Infrastructure: env validation, API client, Supabase client |
| `test/`      | Test setup and helpers                                      |

**Styling.** Tailwind CSS v4 with semantic color tokens defined in `src/index.css` (`canvas`, `ink`,
`accent`, ...). Dark mode follows the operating system (`prefers-color-scheme`). One accent color
(teal). Radius system: controls `rounded-lg`, panels `rounded-xl`, avatars `rounded-full`.

**Forms.** Validated with the same Zod schemas the API uses (`@linka/shared`). Labels sit above
inputs, errors below (linked with `aria-describedby`), form-level messages use `Alert`.

**Motion.** Kept minimal and functional: button hover/press feedback only, disabled under
`prefers-reduced-motion`. Loading placeholders are static (no looping animation).

## Environment and secrets

- `frontend/.env` contains only public values (`VITE_` prefix). `lib/env.ts` rejects Supabase secret
  keys (`sb_secret_...` or legacy `service_role` JWTs) at startup.
- `backend/.env` contains server-only values. Only variable *names* are ever printed when validation
  fails, never values.
- Tests never read real `.env` files (Vite `envDir: false` in test mode; backend tests set their own
  variables), so they cannot hit real services.

## Deployment target (Phase 10)

```text
React (Vercel) -> Express API (Render) -> Supabase (Auth, PostgreSQL, Realtime, Storage)
```

Notes collected so far:

- Render needs the Supabase **session pooler** connection string (the direct connection is IPv6 only).
- Render's free tier sleeps when idle; the first request after that can take ~50 s.
- `GET /api/health` always returns 200 while the process is up, so a database outage does not make
  Render restart a healthy API. The body reports `status: "degraded"` instead.
- `VITE_API_URL` must be set on Vercel; it defaults to `http://localhost:3000` otherwise.
- Vercel needs an SPA rewrite so deep links (e.g. `/chats/123`) serve `index.html`.
