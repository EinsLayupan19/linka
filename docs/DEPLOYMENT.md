# Deploying Linka

This guide takes Linka from "runs on my computer" to "anyone can open it in a browser", step by
step, on free plans. It assumes no deployment experience.

**How to read it.** Do the sections in order. Every step says who does it:

- **[You, dashboard]**: you click something in a website's dashboard.
- **[You, terminal]**: you run a command on your computer (PowerShell, in the `linka` folder).
- **[Needs your approval]**: changes the live database or live settings. Read the step fully
  before doing it.

Values in angle brackets, like `<project-ref>`, are placeholders: replace them with your own
values. **Never paste real keys or passwords into this file, a commit, a chat or a screenshot.**

---

## Contents

1. [Recommended architecture](#1-recommended-architecture)
2. [Accounts and services](#2-accounts-and-services)
3. [Environment variables: what goes where](#3-environment-variables-what-goes-where)
4. [Supabase configuration](#4-supabase-configuration)
5. [Database migrations](#5-database-migrations)
6. [Backend deployment (Render)](#6-backend-deployment-render)
7. [Frontend deployment (Vercel)](#7-frontend-deployment-vercel)
8. [Connect the pieces: CORS and auth redirects](#8-connect-the-pieces-cors-and-auth-redirects)
9. [Domain and HTTPS](#9-domain-and-https)
10. [Verification](#10-verification): CORS, realtime, uploads, calls, smoke tests
11. [Troubleshooting](#11-troubleshooting)
12. [Rollback](#12-rollback)
13. [Costs and free-tier limits](#13-costs-and-free-tier-limits)
14. [Known limitations at launch](#14-known-limitations-at-launch)

---

## 1. Recommended architecture

```text
            Browser (phone or computer)
             │        │                    │
     the app │        │ API requests       │ live events, sign-in, file uploads/downloads
   (HTML/JS) │        │ (HTTPS)            │ (HTTPS + WebSocket, directly)
             ▼        ▼                    ▼
        ┌────────┐ ┌──────────────┐  ┌──────────────────────────────────────────┐
        │ Vercel │ │ Render       │  │ Supabase (Tokyo, ap-northeast-1)         │
        │ static │ │ Express API  │─▶│ Auth · PostgreSQL · Realtime · Storage   │
        │ files  │ │ (Singapore)  │  │                                          │
        └────────┘ └──────────────┘  └──────────────────────────────────────────┘

   Calls: audio and video go browser ↔ browser (WebRTC). Linka's servers only help the two
   browsers find each other; a public STUN server tells each browser its public address.
```

| Piece | Runs on | Plan | Why this one |
| ----- | ------- | ---- | ------------ |
| Frontend (React app) | **Vercel** | Hobby (free) | The app is just static files after `vite build`; Vercel serves them over HTTPS from a global CDN, builds on every push, and supports the page-reload rule a single-page app needs. |
| Backend (Express API) | **Render** | Free web service | Runs a normal, long-lived Node process, which the API needs: it keeps a database connection pool, rate-limit counters in memory, and two background clean-up timers. Serverless hosts (Vercel Functions, Netlify Functions) would stop those between requests. |
| Database, auth, realtime, files | **Supabase** | Free (the project you already use) | Already set up and holding migrations 0000-0010. |

**Why not other options?**

- **Everything on Vercel (API as serverless functions):** possible, but the API's background
  timers (expiring stale calls, sweeping unsent uploads) and in-memory rate limits only work in a
  long-running process. It would need a rewrite. Not worth it.
- **Fly.io, Railway:** no free plan for new accounts (trial credit, then paid).
- **Google Cloud Run:** generous free tier and fast cold starts, but needs a billing account with
  a card, and its CPU is paused between requests, which stops the background timers. More setup
  for a beginner.
- **Render free Postgres:** not needed (Supabase is the database), and it is deleted after 30 days.

**Important consequences of the free plans (read these):**

1. **Cold starts.** Render stops a free service after **15 minutes without requests**. The next
   request wakes it, which takes **about one minute**. For you that means: the first person to
   open Linka after a quiet period waits on the loading screen for up to a minute. Messages
   already open keep arriving live (realtime goes straight to Supabase), but *sending* waits for
   the API to wake. See [section 13](#13-costs-and-free-tier-limits) for the optional fix.
2. **Supabase pauses idle projects.** A free project with no activity for **7 days** is paused.
   Your data stays; you restore it from the dashboard (a few minutes).
3. **Calls use STUN only, no TURN relay.** Calls work when the two browsers can reach each other
   directly (most home Wi-Fi). Some networks block that (many mobile carriers, offices, campuses):
   such calls stay on "Connecting…" and end after 30 seconds. Not a launch blocker; see
   [section 14](#14-known-limitations-at-launch).
4. **Vercel Hobby is for personal, non-commercial use.** If Linka becomes a business, move the
   frontend to a commercial plan (Vercel Pro) or another static host. Nothing in the code depends
   on Vercel.

**Estimated cost: $0/month.** Nothing here needs a credit card. A custom domain is optional
(about $10-15/year, bought by you, never required).

---

## 2. Accounts and services

You need four accounts. Sign up with the same email; GitHub sign-in is easiest for Vercel and Render.

| Service | What for | Credit card? |
| ------- | -------- | ------------ |
| GitHub | Holds the code; Vercel and Render deploy from it | No |
| Supabase | You already have the project | No (stay on Free) |
| Render | Backend | No for the free plan |
| Vercel | Frontend | No for Hobby |
| An email (SMTP) provider | Sign-up confirmation and password-reset emails ([4.2](#42-email-sending-smtp-required-for-real-users-you-dashboard)) | Depends on provider; pick a free one |

The code must be on GitHub (it is: your `master` branch). Vercel and Render redeploy
automatically on every push to `master`.

---

## 3. Environment variables: what goes where

An **environment variable** is a setting the app reads when it starts or builds, kept outside the
code so secrets never end up in Git. Locally they live in `backend/.env` and `frontend/.env`; on the
hosts you type them into each dashboard.

### Render (backend): Dashboard > linka-api > Environment

| Variable | Value | Secret? | Notes |
| -------- | ----- | ------- | ----- |
| `NODE_ENV` | `production` | no | Already in `render.yaml` |
| `TRUST_PROXY` | `1` | no | Already in `render.yaml`. Render has one proxy in front of the API; this lets rate limits see real visitor IPs |
| `CORS_ORIGIN` | `https://<your-frontend>.vercel.app` | no | The frontend's address, `https://`, no path. Several: separate with commas |
| `DATABASE_URL` | `postgresql://postgres.<project-ref>:<db-password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres` | **yes** | Supabase > **Connect** > **Session pooler**. Copy it exactly; check the host and port in your dashboard rather than trusting this example |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | no | Supabase > Project Settings > API |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` | **yes** | Supabase > Project Settings > API Keys > **Secret keys**. Server only |
| `PORT` | *do not set* | | Render sets it |
| `ICE_SERVERS` | *do not set* | | Defaults to a public STUN server |

The API **refuses to start** in production if `CORS_ORIGIN`, `DATABASE_URL`, `SUPABASE_URL` or
`SUPABASE_SECRET_KEY` is missing, or if `CORS_ORIGIN` / `SUPABASE_URL` is not `https://`. The
error in Render's log names the variable, never its value.

### Vercel (frontend): Project > Settings > Environment Variables (environment: **Production**)

| Variable | Value | Secret? | Notes |
| -------- | ----- | ------- | ----- |
| `VITE_API_URL` | `https://<your-api>.onrender.com` | no | Render's address for the API, no path, no trailing `/api` |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` | no | Same as `SUPABASE_URL` above |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` (or the legacy `anon` key) | no (public by design) | Supabase > Project Settings > API Keys > **Publishable key** |

`VITE_` values are **copied into the public JavaScript** that every visitor downloads. That is fine
for these three (they are designed to be public; Row Level Security protects the data). It is why
**`SUPABASE_SECRET_KEY` and `DATABASE_URL` must never be added to Vercel.** The build **fails on
purpose** if a variable is missing, if an address is not `https://` (except `localhost`), or if a
secret key is put in `VITE_SUPABASE_PUBLISHABLE_KEY`.

Vercel reads these **when it builds**. After changing one, redeploy (Deployments > ⋯ > Redeploy).

### Supabase

No variables, only dashboard settings ([section 4](#4-supabase-configuration)).

---

## 4. Supabase configuration

You already configured most of this while developing (see "Supabase setup" in
[DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md)). For production, **check each item** and change
only what is listed as a change.

This guide **reuses your existing Supabase project** as production. It is simplest: keys, buckets,
JWT settings and migrations 0000-0010 are already there. The trade-off: your local development
uses the same database, so test accounts and messages you create locally appear in production.
If you want a clean, separate production project later, create a second free project and repeat
the whole "Supabase setup" list plus all migrations for it.

### 4.1 Checks (no changes expected) [You, dashboard]

| Where | Must be | Why |
| ----- | ------- | --- |
| Project Settings > JWT Keys | Current key is **ECC (P-256)** or **RSA**, not "Legacy HS256" | The API only accepts ES256/RS256 tokens |
| Authentication > Sign In / Providers > Email | **Confirm email: on**; minimum password length **8** | Matches the app's rules |
| Realtime > Settings | **"Allow public access": off** | Only private, permission-checked channels; all of Linka's channels are private |
| Storage | Buckets **`attachments`** and **`avatars`** exist and are **private** | Files are only reachable through short-lived signed links from the API |
| Storage > Policies | **No** policies on these buckets | Browsers must not access storage directly; do not add any |
| Project Settings > Data API > Exposed schemas | `public`, `graphql_public` only; **not** `private` | `private` holds permission helpers |

### 4.2 Email sending (SMTP): required for real users [You, dashboard]

**This is a launch blocker for anyone except you.** Supabase's built-in email service only sends
to **members of your Supabase team**, at most **2 emails per hour**. Anyone else trying to sign
up gets "Email address not authorized" and can never confirm their account; password-reset
emails fail the same way.

Fix: *Authentication > Emails > SMTP Settings* > **Enable custom SMTP**, with an email provider's
SMTP details (host, port, username, password, sender address). Free options exist. Typical
choices: a transactional email service's free tier (most need a domain you own to send to anyone),
or a personal mail account's SMTP with an app password (low daily limits, fine for a small
launch). Check the provider's current free limits and terms before choosing. The SMTP password is
a secret: it goes only into this Supabase form.

*Do not* turn "Confirm email" off to work around this: anyone could then register with someone
else's address, and password resets would still not be delivered.

### 4.3 Auth URLs (after the frontend has an address) [Needs your approval]

Done in [section 8](#8-connect-the-pieces-cors-and-auth-redirects), because you need the
Vercel address first.

---

## 5. Database migrations

A **migration** is a numbered SQL file that changes the database's structure (adds a column, a
rule, a trigger). They must run in order, exactly once. Drizzle records which ones ran in a
table called `drizzle.__drizzle_migrations`.

### 5.1 Current state (checked read-only on 2026-11-04)

| Migrations | State on your Supabase project |
| ---------- | ------------------------------ |
| `0000` to `0010` | **Applied** (11 entries) |
| `0011_group_owner_invariant` | **Not applied** |
| `0012_conversation_channel_version` | **Not applied** (the `conversations.channel_version` column does not exist yet) |
| `0013_versioned_realtime_topics` | **Not applied** |

**These three must be applied before the new backend goes live.** The current code reads
`channel_version`. Without it, every conversation request fails ("Something went wrong") and live
updates stop. This is also true for your *local* development right now, since it uses the same
database.

### 5.2 What 0011-0013 do (and do not do)

| Migration | What it changes | Touches existing data? |
| --------- | --------------- | ---------------------- |
| `0011` | Adds a check, run when a change is saved, that a group always keeps an owner | No. It only checks future changes |
| `0012` | Adds the column `conversations.channel_version` (a number, starting at 0) | Adds the column with 0 for every row; nothing else changes |
| `0013` | Realtime topics become `conversation:<id>:<version>` and `live:<id>:<version>`; replaces 7 trigger/permission functions; removing a member bumps the version | No rows changed. Browsers that still run the *old* app lose live updates until they reload |

So the risk to your data is low. The visible effect is that anyone with the old version of the app
open stops getting live updates until they reload the page. Migrations are applied in one
transaction: if one fails, none of them is applied.

**Backups.** The Free plan has no automatic backups. If you have PostgreSQL's `pg_dump` installed,
you can take one first (optional):
`pg_dump "<DATABASE_URL>" --schema=public --schema=private -Fc -f linka-before-0011.dump`
(run it where the file stays private; the dump contains everyone's data).

### 5.3 Apply them [Needs your approval] [You, terminal]

Your `backend/.env` already contains the Session pooler `DATABASE_URL` (that is how 0000-0010 were
applied). From the `linka` folder:

```powershell
cd backend
npm run db:migrate
cd ..
```

Expected: drizzle-kit prints the migrations it applies and ends without an error. Then verify in
Supabase > **SQL Editor** (read-only queries):

```sql
-- 14 rows expected (0000-0013)
select count(*) from drizzle.__drizzle_migrations;

-- the new column exists
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'conversations' and column_name = 'channel_version';

-- the owner check exists
select tgname from pg_trigger where tgname = 'conversation_members_group_owner';

-- the new topic helper exists
select proname from pg_proc where proname = 'can_access_versioned_topic';
```

If `npm run db:migrate` fails, **do not edit the migration files**. Copy the error text (it does not
contain your password) and stop; nothing was applied.

---

## 6. Backend deployment (Render)

The repository contains `render.yaml` (a "Blueprint"): it tells Render how to build and start the
API, so you do not type commands into the dashboard.

What it sets up:

- **Build:** `npm ci --include=dev` (installs exactly what `package-lock.json` lists, including the
  TypeScript compiler), then builds `shared` and `backend`.
- **Start:** `node backend/dist/server.js`.
- **Health check:** `/api/health`. Render calls it to know the service is up.
- **Node.js 24** (from `.node-version`).
- **Region: Singapore**, the closest Render region to your Supabase project in Tokyo.
- Only redeploys when backend, shared or install files change.

### Steps [You, dashboard]

1. Render dashboard > **New** > **Blueprint**. Connect your GitHub account and pick the Linka
   repository, branch `master`.
2. Render reads `render.yaml` and shows one service, **linka-api**, plan **Free**. It asks for the
   four values marked secret:
   - `CORS_ORIGIN`: your future frontend address. If you do not know it yet, enter
     `https://linka.vercel.app` (you will correct it in [section 8](#8-connect-the-pieces-cors-and-auth-redirects)).
   - `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: see the [table above](#render-backend-dashboard--linka-api--environment).
3. **Apply** / **Deploy**. The first build takes a few minutes. Watch **Logs**. Success looks like
   `Linka API listening on port 10000 (production)` (the port number may differ).
4. Note the service's address at the top, e.g. `https://linka-api.onrender.com` (Render may add
   a suffix if the name is taken). This is your `<your-api>` address.
5. Check it [You, terminal]. In PowerShell, use **`curl.exe`** (plain `curl` means something else
   in Windows PowerShell):

   ```powershell
   curl.exe -i https://<your-api>.onrender.com/api/health
   ```

   Expected: `HTTP/1.1 200` and `{"status":"ok","database":"connected"}`. If it says
   `"degraded"`, see [Troubleshooting](#11-troubleshooting).

---

## 7. Frontend deployment (Vercel)

The repository contains `vercel.json`, which tells Vercel:

- install with `npm ci --include=dev`, build `shared` then `frontend`, publish `frontend/dist`;
- send every address except files under `/assets/` to `index.html`. Linka is a *single-page app*:
  the browser handles addresses like `/chats/123` itself, so a reload there must still get the app.
  Missing files under `/assets/` correctly answer 404;
- cache the fingerprinted files in `/assets/` for a year (their names change on every build);
- add security headers: no embedding in other sites' frames, no MIME sniffing, a strict referrer,
  and camera/microphone allowed only for Linka itself.

### Steps [You, dashboard]

1. Vercel dashboard > **Add New…** > **Project** > import the Linka repository.
2. **Root Directory: leave it as the repository root** (`./`). Do not pick `frontend`: the build
   needs the whole workspace (it builds `shared` first). Framework preset: "Other" is fine;
   `vercel.json` provides the commands.
3. Before deploying, open **Environment Variables** and add the three `VITE_` variables from
   [section 3](#vercel-frontend-project--settings--environment-variables-environment-production),
   for **Production** (and Preview, if you want preview builds to succeed).
4. **Node.js version** (Project > Settings > Build and Deployment): **24.x**.
5. **Deploy.** If a variable is missing or wrong, the build stops with
   `Cannot build the frontend: fix these environment variables…` and a list. Fix them and redeploy.
6. Note the production address, e.g. `https://linka.vercel.app` (or `https://linka-<something>.vercel.app`).
   This is your `<your-frontend>` address.

Preview deployments (one per branch or pull request) get other addresses, which the API's CORS
setting does not allow. That is intended: only the production address talks to the production API.

---

## 8. Connect the pieces: CORS and auth redirects

The three services now exist but do not fully trust each other yet.

### 8.1 CORS on Render [You, dashboard]

**CORS** is the browser's rule that a page from one address (Vercel) may only call an API at
another address (Render) if the API says that page is allowed. The API allows exactly the
addresses in `CORS_ORIGIN`.

Render > linka-api > **Environment** > set `CORS_ORIGIN` to your exact frontend address, e.g.
`https://linka.vercel.app` (https, no path; a trailing `/` is tolerated). Save; Render restarts
the API (about a minute).

### 8.2 Auth URLs in Supabase [Needs your approval] [You, dashboard]

Sign-up confirmation and password-reset emails contain a link back to the app. Supabase only
sends people to addresses on its allow-list.

*Authentication > URL Configuration*:

- **Site URL:** `https://<your-frontend>` (e.g. `https://linka.vercel.app`). This is the default
  link in emails.
- **Redirect URLs:** add `https://<your-frontend>/**`. **Keep** `http://localhost:5173/**` so local
  development keeps working.

The app asks for `https://<your-frontend>/` after sign-up and
`https://<your-frontend>/reset-password` for resets; both match `https://<your-frontend>/**`.

---

## 9. Domain and HTTPS

- **HTTPS is automatic** on both `*.vercel.app` and `*.onrender.com`, with no setup. Browsers
  only allow the camera and microphone on HTTPS pages, so this matters for calls.
- **A custom domain is optional** and costs money (you buy it from a registrar). Not needed to
  launch. If you add one later [Needs your approval]:
  1. Vercel > Project > Settings > **Domains** > add `app.<yourdomain>`; create the DNS record
     Vercel shows at your registrar; Vercel issues the certificate.
  2. Add the new address to Render's `CORS_ORIGIN` (comma-separated, keep the old one until the
     switch is done) and to Supabase's Site URL and Redirect URLs.
  3. Optionally `api.<yourdomain>` for Render (Settings > Custom Domains), then change Vercel's
     `VITE_API_URL` and redeploy.

---

## 10. Verification

Do these in order after sections 5-8. Use two different browsers (or one normal and one
private window) and, for calls, two devices.

### 10.1 CORS [You, terminal]

```powershell
# Allowed: must show "Access-Control-Allow-Origin: https://<your-frontend>"
curl.exe -i -X OPTIONS https://<your-api>.onrender.com/api/users/me -H "Origin: https://<your-frontend>" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: authorization"

# Not allowed: must NOT show any Access-Control-Allow-Origin line
curl.exe -i -X OPTIONS https://<your-api>.onrender.com/api/users/me -H "Origin: https://evil.example" -H "Access-Control-Request-Method: GET"
```

### 10.2 Production smoke tests

| # | Do | Expect |
| - | -- | ------ |
| 1 | `curl.exe -i https://<your-api>.onrender.com/api/health` | `200`, `"status":"ok"`, `"database":"connected"` |
| 2 | `curl.exe -i https://<your-api>.onrender.com/api/users/me` | `401` with `{"error":{"code":"UNAUTHORIZED",…}}` (no stack trace) |
| 3 | `curl.exe -I https://<your-frontend>/chats/does-not-exist` | `200` (the app; it shows its own "not found") |
| 4 | `curl.exe -I https://<your-frontend>/assets/nope.js` | `404` |
| 5 | Open `https://<your-frontend>/status` | API, database and Supabase all shown as working |
| 6 | Register with a real email address you own (not your Supabase team address, to test SMTP) | Confirmation email arrives; its link opens `https://<your-frontend>` and signs you in |
| 7 | Finish onboarding (username) | Lands on Chats |
| 8 | "Forgot password" for that account | Email arrives; link opens `/reset-password` on the live site; new password works |
| 9 | Log out, log in | Works; reloading a chat page keeps you signed in |
| 10 | Profile > Appearance: dark / light | Switches; survives a reload |

### 10.3 Realtime (two accounts, two browsers)

| Do | Expect |
| -- | ------ |
| Start a 1:1 chat from A to B; send from A | Appears in B's open chat **without reloading**; B's list shows the preview and unread badge |
| B opens the chat | A sees "Delivered", then "Read"; both show "Online" |
| Type in A | B sees "typing…" |
| Group with A, B and a third account C; send messages | Appear live for everyone |
| A (owner) removes C while C has the group open; then A sends a message | C's page shows "Conversation not found" and C does **not** receive the new message; A and B keep receiving live (this checks migrations 0012-0013) |
| A re-adds C | C gets the group back and receives live again |

If messages only appear after a reload, see [Troubleshooting](#11-troubleshooting).

### 10.4 File uploads

| Do | Expect |
| -- | ------ |
| Send a photo with a caption, and a PDF | Both appear live for the other person; the photo opens full size; the PDF downloads with its name |
| Try a file over the limit (images 10 MB, other files 25 MB) | Refused before uploading |
| Cancel an upload halfway | It disappears; nothing is sent |
| Set a profile picture | Shows for you; for the other person after a reload |

### 10.5 Voice and video calls (two devices)

Calls need HTTPS (automatic here) and permission for the microphone (and camera).

| Do | Expect |
| -- | ------ |
| Both devices on the **same Wi-Fi**: voice call, accept, talk, mute, end | Audio both ways; mute works; both sides return to the chat |
| Video call, accept; each side turns its camera off and on | Video both ways; "Camera off" shown while off |
| Call and decline; call and let it ring 45 s | "Declined" / "No answer" |
| Reload one side during a call; use **Join here** | Rejoins |
| **Different networks**: one device on Wi-Fi, the other on mobile data | May connect, or may stay on "Connecting…" and end after 30 s. That second case is the missing TURN relay ([section 14](#14-known-limitations-at-launch)), not a deployment error |

### 10.6 Rate limits and the proxy setting (optional)

```powershell
# 61+ requests without a token from your computer within a minute: the last ones get 429
1..65 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code} " https://<your-api>.onrender.com/api/users/me }
```

Expect mostly `401`, then `429` near the end. Then, **while still blocked**, open Linka in a
browser on a different network (e.g. your phone on mobile data) and sign in: it must work. If the
phone is blocked too, `TRUST_PROXY` does not match Render's setup and every visitor is sharing one
allowance (see [Troubleshooting](#11-troubleshooting)).

---

## 11. Troubleshooting

**First check the logs.** Render > linka-api > **Logs** (the API logs errors without message
contents or passwords). Vercel > Project > Deployments > a deployment > **Build Logs**. In the
browser: F12 > **Console** and **Network**.

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| Vercel build fails: `Cannot build the frontend: fix these environment variables` | A `VITE_` variable is missing, not `https://`, has a path, or is a secret key | Fix it in Vercel > Settings > Environment Variables (Production), then Redeploy |
| Render deploy fails: `Invalid backend environment variables` … `→ at CORS_ORIGIN` (or another name) | That variable is missing or invalid | Fix it in Render > Environment; Render redeploys |
| Render build fails: `tsc: not found` or similar | Build command changed and devDependencies were skipped | Use the command from `render.yaml` (`npm ci --include=dev …`) |
| First page load takes ~1 minute | Render free cold start | Normal; see [section 13](#13-costs-and-free-tier-limits) |
| Health shows `"database":"unreachable"` | `DATABASE_URL` wrong, or Supabase paused | Copy the **Session pooler** string again (not "Direct connection", which needs IPv6); if your password has `@`, `#`, `/` or `%`, reset it to one without them or URL-encode it; check Supabase isn't paused |
| Browser console: `blocked by CORS policy` | `CORS_ORIGIN` does not exactly match the frontend address | Set it to `https://<your-frontend>` exactly; wait for the restart |
| Every API call: "Your session is invalid or has expired" | Frontend and backend point to different Supabase projects | `VITE_SUPABASE_URL` (Vercel) and `SUPABASE_URL` (Render) must be the same |
| "Could not verify your session. Try again shortly." (503) | The API could not reach Supabase's signing keys | Usually temporary; check `SUPABASE_URL` and Supabase status |
| Sign-up: "Email address not authorized" | Built-in email only sends to your Supabase team | Set up custom SMTP ([4.2](#42-email-sending-smtp-required-for-real-users-you-dashboard)) |
| Email link opens `localhost` or says "redirect not allowed" | Supabase Auth URLs not updated | [Section 8.2](#82-auth-urls-in-supabase-needs-your-approval-you-dashboard) |
| Every chat shows "Something went wrong"; Render log: `column … channel_version does not exist` | Migrations 0011-0013 not applied | [Section 5.3](#53-apply-them-needs-your-approval-you-terminal) |
| Messages appear only after reloading | Realtime blocked: migration 0013 missing, or an old app version still open | Apply migrations; reload both browsers; check the console for channel errors |
| Uploads: "not configured" (503) | `SUPABASE_SECRET_KEY` missing on Render | Add it (the secret key, not the publishable one) |
| Upload fails in the browser with a CORS error on `*.supabase.co` | Storage's allowed origins | Check Storage settings for the project's allowed origins |
| "Too many requests" for normal users | `TRUST_PROXY` wrong, so everyone shares one IP | Check it is `1`; test with [10.6](#106-rate-limits-and-the-proxy-setting-optional) |
| Camera or microphone never asked / blocked | Browser permission denied earlier, or not HTTPS | Allow it in the browser's site settings (lock icon) |
| Calls stuck on "Connecting…" across networks | No TURN relay | Known limitation ([section 14](#14-known-limitations-at-launch)) |
| After a new deploy, someone sees "Something went wrong" when opening a page | Their open tab still runs the previous version, whose files were replaced | "Reload page" fixes it |
| Whole site down, Supabase dashboard shows "Paused" | 7 days without activity | Supabase > project > **Restore** |

---

## 12. Rollback

**Code (frontend or backend) went bad:**

- **Vercel:** Project > **Deployments** > the last good one > ⋯ > **Promote to Production** /
  **Instant Rollback**. Takes seconds. (Hobby may only offer rollback to the previous production
  deployment.)
- **Render:** linka-api > **Events** (or Deploys) > the last good deploy > **Rollback**. Takes
  about a minute.
- Then fix the code locally, test, commit and push; both redeploy automatically.

**Database:** migrations only move forward. There are no "undo" files, and you should never delete
rows from `drizzle.__drizzle_migrations`.

- **Rolling back code to any commit from `cf4d367` onward is safe**: those versions expect
  migrations 0000-0013.
- **Do not roll back to a commit before `cf4d367`** once 0011-0013 are applied: older versions use
  the old realtime topic names, which 0013 no longer allows, so live updates would stop. If that is
  ever truly needed, the old functions would have to be restored with hand-written SQL. Ask for
  that to be prepared and reviewed; don't improvise it.
- If a migration fails while being applied, nothing is applied (one transaction). Fix the cause
  and run it again.

**A secret leaked** (pasted somewhere public, committed): rotate it immediately.

- `SUPABASE_SECRET_KEY`: Supabase > API Keys > create a new secret key, put it on Render, then
  delete the old key.
- Database password: Supabase > Database settings > reset password; update `DATABASE_URL` on
  Render and in your local `backend/.env`.
- Removing it from Git history is not enough: anyone may already have copied it.

---

## 13. Costs and free-tier limits

All plans below are free; none needs a card. Figures are from the providers' pages on
2026-11-04. They change, so check before relying on them.

| Service | Main free limits that matter for Linka | When exceeded |
| ------- | -------------------------------------- | ------------- |
| Render Free | 750 instance hours/month (enough for one service 24/7); sleeps after 15 min idle, ~1 min to wake; 512 MB RAM; may be restarted at any time | Services suspended until next month (no surprise bill without a payment method) |
| Vercel Hobby | 100 GB data transfer/month, personal non-commercial use | Feature paused until the 30-day window resets |
| Supabase Free | 500 MB database, 1 GB file storage, 5 GB egress (downloads), 50,000 monthly active users, 200 concurrent realtime connections, 2 million realtime messages/month, 50 MB max upload; pauses after 7 days idle; **no backups**; 2 free projects | Restricted until you upgrade or the cycle resets |

**Things that could cost money (all optional, none needed to launch):** a custom domain; Render,
Vercel or Supabase paid plans; a TURN relay provider beyond its free allowance; a paid email
provider. Never enter a card unless you decide to.

**What fills up first:** with photos and files, **Supabase's 1 GB storage and 5 GB/month egress**.
Every time someone views a photo it counts as egress. Watch *Supabase > Usage*.

**Optional: avoiding cold starts.** A free uptime monitor that requests
`https://<your-api>.onrender.com/api/health` every 10 minutes keeps the API awake, and (because
the health check queries the database) also keeps Supabase from pausing. Trade-off: the API then
runs all month, using about 744 of the 750 free Render hours, so a second free Render service
would run out. Decide this yourself.

---

## 14. Known limitations at launch

- **No TURN relay** (calls across restrictive networks fail). The API already hands browsers its
  `ICE_SERVERS` list, so adding a TURN provider later needs no frontend change; prefer one with
  short-lived credentials.
- **Cold starts** on Render Free (about a minute after 15 minutes idle).
- **Clean-up jobs pause while the API sleeps** (expiring stale calls, removing uploads never sent).
  They catch up after it wakes; nothing is lost.
- **Rate limits are per API process** and reset when it restarts or wakes.
- **Old open tabs after a deploy** may need a reload.
- **Shared database for development and production** (this guide's choice); see 4.
- **No automatic database backups** on Supabase Free.
- **No Content-Security-Policy header yet.** The other security headers are set; a CSP needs
  careful testing against Supabase, signed file URLs and calls, so it is a follow-up.
- Phones: video calls have not been tested on real phones yet.

---

## Deployment order (one-page summary)

1. [You, dashboard] Supabase checks (4.1) and custom SMTP (4.2).
2. [Needs your approval] [You, terminal] Apply migrations 0011-0013 (5.3) and verify.
3. [You, dashboard] Render Blueprint (6). Note `<your-api>`. Check `/api/health`.
4. [You, dashboard] Vercel project with the three `VITE_` variables (7). Note `<your-frontend>`.
5. [You, dashboard] Render `CORS_ORIGIN` = `<your-frontend>` (8.1).
6. [Needs your approval] [You, dashboard] Supabase Site URL and Redirect URLs (8.2).
7. Verification (10): CORS, smoke tests, realtime, uploads, calls.
