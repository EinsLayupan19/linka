# Linka

A real-time messaging and calling platform: 1:1 and group chats, read/delivery states, presence,
typing indicators, file sharing, and WebRTC voice/video calls.

> Status: **Phase 7 (voice calls)**. See [docs/DEVELOPMENT_STATUS.md](docs/DEVELOPMENT_STATUS.md).
>
> Built so far (tested locally; not yet verified against a hosted Supabase project): sign-up and
> login, profiles and profile pictures, finding people by username, 1:1 conversations, sending text
> messages, images and files, live delivery, paging through history, delivered/read receipts,
> unread counts, a live conversation list, online/last seen, and typing indicators. Realtime uses
> Supabase Broadcast from Database and Presence on private channels
> ([messaging](docs/ARCHITECTURE.md#messaging-and-realtime-phase-4),
> [live state](docs/ARCHITECTURE.md#live-state-phase-5-receipts-unread-counts-live-list-presence-typing)).
> Files live in private Supabase Storage buckets behind short-lived signed URLs
> ([files and media](docs/ARCHITECTURE.md#files-and-media-phase-6)). 1:1 voice calls run over WebRTC, browser
> to browser ([voice calls](docs/ARCHITECTURE.md#voice-calls-phase-7)).

## Tech stack

| Layer      | Choice                                             |
| ---------- | -------------------------------------------------- |
| Frontend   | React, TypeScript, Vite, Tailwind CSS, React Router |
| Backend    | Node.js, TypeScript, Express                       |
| Database   | PostgreSQL (Supabase) with Drizzle ORM             |
| Auth, Realtime, Storage | Supabase                              |
| Calls      | WebRTC (signaling over Supabase Realtime)          |
| Validation | Zod, shared between frontend and backend           |
| Testing    | Vitest, React Testing Library, Supertest           |

## Repository layout

```text
linka/
├── shared/     @linka/shared   Zod schemas and types used by both apps
├── backend/    @linka/backend  Express API
├── frontend/   @linka/frontend React web client
└── docs/                       Architecture, database and status notes
```

It is an npm workspaces monorepo: one `npm install` at the root installs everything.

## Getting started

Requirements: Node.js 22.12+ (or 24+) and npm.

```bash
npm install

# Optional until you have a Supabase project. Both apps run without them.
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:3000 (health check: `GET /api/health`)

`/status` shows a live check of the API, the database and the Supabase client configuration.
Sign-up and login need a Supabase project (see the setup steps in
[docs/DEVELOPMENT_STATUS.md](docs/DEVELOPMENT_STATUS.md)).

**Port already in use?** The web port is strict (it will not silently switch ports, which would break
CORS). Run the frontend on another port and allow it in `backend/.env`:

```bash
# backend/.env
CORS_ORIGIN=http://localhost:5199

npm run dev -w @linka/frontend -- --port 5199
```

## Scripts (run from the root)

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Shared package (watch), API and web together          |
| `npm run build`     | Production build of all three packages               |
| `npm run typecheck` | TypeScript checks (including tests)                  |
| `npm test`          | All test suites                                       |
| `npm run lint`      | ESLint across the repo                                |

Database (from `backend/`, needs `DATABASE_URL`): `npm run db:generate`, `npm run db:migrate`.

## Environment variables

Each app has its own `.env.example`. Real `.env` files are git-ignored.

- `frontend/.env`: **public** values only. Everything with the `VITE_` prefix ends up in the browser
  bundle. The app refuses to start if a Supabase secret key is put here.
- `backend/.env`: server-side values such as `DATABASE_URL` and `SUPABASE_URL` (used with the
  project's public signing keys to verify access tokens), and `SUPABASE_SECRET_KEY` for file
  storage (and optionally `ICE_SERVERS`, STUN/TURN servers for calls). The secret key is **server-only**: it never goes in `frontend/.env`, the browser, logs or
  Git. Without it the app runs, but uploads and profile pictures answer "not configured".

## Documentation

- [PLAN.md](PLAN.md): product and architecture plan (source of truth)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is organised
- [docs/DATABASE.md](docs/DATABASE.md): database and migration workflow
- [docs/DEVELOPMENT_STATUS.md](docs/DEVELOPMENT_STATUS.md): progress per phase
