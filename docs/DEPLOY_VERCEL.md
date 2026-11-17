# Deploying a private review build on Vercel + Neon

## Fastest: no database at all (embedded demo)

Deploy `main` to a Vercel project **without** any database attached. The build (`vercel-build` → `scripts/build-demo-db.ts`) runs PostgreSQL in-process (PGlite, WASM): it applies every migration, loads the demo data and ships a 7 MB snapshot (`.demo-db/`) with the functions. At runtime:

- `DB_DRIVER=pglite` and the other settings are set automatically. `AUTH_SECRET` is a random value generated per build (independent of any credential) and never printed.
- **Same app, same rules.** The full platform runs on the same schema, row-level security (as the `luma_app` role) and SQL as production.
- **Data is temporary.** Each server instance starts from the snapshot. Changes live in memory and disappear when Vercel recycles the instance. With several instances active, a session made on one may not exist on another, so you may need to sign in again.
- **Sign-in (owner decision R3, 2026-11-17).** Demo accounts sign in **with a password only**: set the build secret `DEMO_ACCOUNT_PASSWORD` (12+ characters) before deploying; every seeded demo account gets it. There is **no one-click demo sign-in, no on-screen code and no dev outbox** on any deployed build. Registration, password recovery and WhatsApp MFA show an honest "not available on this build" message (no messaging provider). Platform staff set up an **authenticator app (TOTP)** at the two-step prompt; the fixed demo code `2002` is accepted only on a *local* embedded demo, never on a deployed one.

Attach Neon later (Quick start below) for persistent data. The build then switches to it automatically.

## Quick start (zero configuration)

On a Vercel project with the **Neon integration** (Storage → Neon), just deploy `main`. The build command `vercel-build` (`scripts/vercel-setup.ts`) then does all of the following automatically:

- creates the non-owner runtime role `luma_app`;
- applies migrations;
- loads the demo data once.

At runtime the app points itself at the non-owner role (its password is derived from the owner's so build and runtime agree). **Application secrets are never derived from database credentials** (LUMA-AUDIT-029): set them yourself in Vercel → Settings → Environment Variables (Preview and Production):

| Variable | Required | Value |
|---|---|---|
| `AUTH_SECRET` | **yes** — the server refuses to start without it | `openssl rand -base64 32` |
| `APP_ENV` | **yes on the Production environment** (`review` or `production`); Preview defaults to `review` | `review` |
| `DEMO_ACCOUNT_PASSWORD` | to sign in to the demo accounts (build time) | 12+ random characters |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | to use the payment sandbox (24+ characters, different from `AUTH_SECRET`); unset = sandbox disabled | `openssl rand -base64 32` |
| `STORAGE_DRIVER` | default `db` | — |
| `APP_URL` | default from the Vercel URL | — |

`DEV_OTP_ECHO` and `DEMO_MODE` are local-development switches: **a deployed build refuses to start if either is `true`** (and on Vercel, `APP_ENV=development`/`test` is refused too), with an error naming the setting. `GET /api/v1/health` lists the offending setting names (never values).

Set `LUMA_DATABASE_URL` to manage the database manually (the steps below), and `LUMA_SKIP_SEED=1` to skip demo data.

The demo data is fake. Still enable **Deployment Protection** (step 5) so the URL is not public.

Sign in with a demo account and `DEMO_ACCOUNT_PASSWORD` (step 6). Background jobs are optional here: expired holds are released whenever a booking or availability request touches them. Add `CRON_SECRET` plus the scheduled-jobs workflow for reminders and other sweeps.

### What derives from `AUTH_SECRET` (rotation impact)

`AUTH_SECRET` keys several things; rotating it has these effects:

| Uses `AUTH_SECRET` | Effect of rotating it |
|---|---|
| Session, verification-code, invitation and preview token hashes (`hashToken`) | every session ends (everyone signs in again); outstanding codes and **pending staff invitation links stop working** (send new invitations) |
| Admin authenticator-app (TOTP) secrets, Loom connector secrets, Instagram tokens (AES-256-GCM, key via HKDF) | **cannot be decrypted any more**: platform staff must have MFA reset and enrol again; Loom connectors and Instagram must be reconnected |
| Gift-card code lookups and gift view links (`hashToken`), online gift-card codes (AES-256-GCM, key via HKDF) | **existing gift cards can no longer be found by their code** and gift links stop working — rotate only with a planned re-issue |
| Guest cart cookies (`hashToken`) | guests' carts are emptied |
| Marketing suppression hashes and unsubscribe links (HMAC) | existing unsubscribe links stop verifying; the suppression list no longer matches (opt-outs must be re-imported) |
| Embedded demo: signed session cookies | everyone signs in again (a new build already gets a new secret) |

`PAYMENT_SANDBOX_WEBHOOK_SECRET` only signs simulated sandbox webhooks; rotating it invalidates sandbox webhooks in flight. The `luma_app` database password is derived from the Neon owner password and is re-applied by every build, so rotating the owner password needs a redeploy.

### Exposure assessment of earlier review builds (LUMA-AUDIT-001)

Before this change, any Vercel deployment of this repository that did **not** set `DEV_OTP_ECHO=false` explicitly echoed password-reset codes in the API response, served `GET /api/v1/auth/dev-outbox` (any address's latest codes) and showed platform WhatsApp-MFA codes; the embedded demo also offered one-click demo sign-in and accepted the fixed MFA code `2002`. Affected by configuration: (a) Neon-attached Preview/Production deployments relying on the zero-config defaults (`APP_ENV=review` + `DEV_OTP_ECHO=true` set by `src/server/hosting/vercel.ts`), (b) manual setups following the old step 4 table (`DEV_OTP_ECHO=true`), (c) every embedded (no database) deployment. Their `AUTH_SECRET` (Neon zero-config) was derived from the database owner password. **Whether any code was actually read by a third party cannot be determined from the code**: it needs the Vercel request logs for `/api/v1/auth/recovery/request`, `/api/v1/auth/dev-outbox` and `/api/v1/platform/mfa/*` (and Deployment Protection settings) for each deployment. Recommended after deploying this change: set a new independent `AUTH_SECRET` (ends all sessions), reset admin MFA, and rotate the Neon owner password if the old derived secret may have been exposed.

The detailed manual setup follows.


This deploys LUMA as a **review build** (`APP_ENV=review`). The payment sandbox keeps
working; one-time codes are **never** shown on screen (registration and recovery are
unavailable until a messaging provider is connected), and the build is hardened like
production: secure cookies, mandatory admin MFA (authenticator app), and `noindex` on
every page. It is **not** for real customers. No real money moves and no messages are sent.

Vercel cannot run the long-lived `pnpm worker` process and has no persistent disk, so:

| Need | How it is met on Vercel |
|---|---|
| Uploaded files, exports | `STORAGE_DRIVER=db` stores files in PostgreSQL (`stored_files`) |
| Background worker | GitHub Actions calls `GET /api/v1/internal/cron` every 5 minutes (`.github/workflows/scheduled-jobs.yml`) |
| Migrations, app DB role, demo data | GitHub Actions workflow `Database (hosted)` (`.github/workflows/database.yml`) |
| PDF invoices | Chromium is not available on Vercel. PDF download returns an honest 503, and the print view (`?format=html`) works; use the browser's "Save as PDF" |

Expired booking holds are also released inline, whenever a booking or availability request touches the slot, so a late cron run never double-books.

## 1. Database (Neon)

1. In Vercel, open **Storage → Create → Neon** and connect it to the project.
2. In the Neon console, copy two connection strings for the owner role (`neondb_owner`):
   - **Direct** (host without `-pooler`). It is used for migrations, which take an advisory lock.
   - **Pooled** (host with `-pooler`). Its host is used for the app.

## 2. Secrets (never paste them into chats or commits; this repository is public)

Generate three random values, for example with `openssl rand -base64 32`:
`APP_DB_PASSWORD`, `AUTH_SECRET`, `CRON_SECRET`.

**GitHub → Settings → Secrets and variables → Actions:**

| Name | Kind | Value |
|---|---|---|
| `DATABASE_OWNER_URL` | secret | Neon **direct** owner connection string |
| `APP_DB_PASSWORD` | secret | the generated password |
| `AUTH_SECRET` | secret | the generated value (the same in Vercel) |
| `CRON_SECRET` | secret | the generated value (the same in Vercel) |
| `APP_URL` | **variable** | your Vercel URL, e.g. `https://luma3.vercel.app` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | secret | only if Deployment Protection is on (step 5) |

## 3. Prepare the database

GitHub → **Actions → Database (hosted) → Run workflow**, with **Load demo data** ticked.

The workflow does three things:
1. It creates the runtime role `luma_app`. This role does not own the tables, so row-level security applies to it.
2. It applies all migrations.
3. It loads the demo businesses.

Demo passwords are random and are **not** shown anywhere, because this repository is public. Step 6 explains how to sign in.

Later, migrations run automatically whenever `db/migrations/**` changes on `main`.

## 4. Vercel environment variables (Production and Preview)

| Name | Value |
|---|---|
| `APP_ENV` | `review` |
| `APP_URL` | your Vercel URL |
| `LUMA_DATABASE_URL` | `postgresql://luma_app:<APP_DB_PASSWORD>@<POOLED-HOST>/<DB>?sslmode=require`, where host and database are copied from the pooled owner string and only the user and password change. It takes precedence over the `DATABASE_URL` that the Neon integration injects (that one is the table **owner**, which would bypass row-level security; deployed builds refuse to serve with it) |
| `DB_APP_ROLE` | `luma_app` |
| `DB_POOL_MAX` | `3` |
| `AUTH_SECRET` | same as GitHub |
| `CRON_SECRET` | same as GitHub |
| `STORAGE_DRIVER` | `db` |
| `DEMO_ACCOUNT_PASSWORD` | 12+ random characters: the password of every seeded demo account (applied at each build) |
| `DEV_OTP_ECHO` / `DEMO_MODE` | **do not set** (a deployed build refuses to start when either is `true`) |
| `PLATFORM_MFA_REQUIRED` | `true` (already enforced by `APP_ENV=review`) |
| `TRUSTED_PROXY_HOPS` | `1` |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | another random value (24+ characters, different from `AUTH_SECRET`) |

Do **not** set `DATABASE_OWNER_URL` in Vercel: the app never needs owner rights. Then redeploy.

## 4b. Production branch

Vercel → Project → **Settings → Git → Production Branch** = `main`, then **Deployments → Redeploy** the latest `main` commit. A Vercel-styled page saying `404 NOT_FOUND` with an id like `bom1::…` comes from Vercel, not the app: there is no deployment at that address yet (wrong URL, or no production deployment).

## 5. Keep it private (recommended)

Vercel → Project → **Settings → Deployment Protection → Vercel Authentication**. Only people on your Vercel team can open the site.

Then create **Protection Bypass for Automation** and save its value as the GitHub secret `VERCEL_AUTOMATION_BYPASS_SECRET`, so scheduled jobs can still reach the app.

Review builds no longer show any code, but the demo accounts share one password and the data is fake; keep the URL private.

## 6. First sign-in

1. Open `/auth/login` and sign in with a demo account, for example `owner@noura.demo`, and the `DEMO_ACCOUNT_PASSWORD` you set.
2. For the LUMA admin (`admin@luma.demo`), sign in the same way; at the two-step prompt choose **Set up an authenticator app** and confirm with its code. Do this right after deploying: the first enrolment is protected by the password only.
3. Staff invitations: with no messaging provider nothing is sent; the inviting owner copies the link shown after inviting (only she sees it) and shares it. The invitee must sign in with the invited, verified email/phone (on a review build: an existing demo account).

Demo accounts: `admin@luma.demo` (platform owner), `reviewer@luma.demo`, `owner@noura.demo`, `manager@noura.demo`, `reception@noura.demo`, `sara@noura.demo` (specialist), `finance@noura.demo`, `lamar@lamar.demo` (independent expert), `customer@demo.test`, `restricted@demo.test`, `new@demo.test`.

Storefronts: `/s/noura-salon`, `/s/lamar-makeup`.

## Checks

- `GET /api/v1/health` returns `{"ok":true,"db":"up","rls":"enforced"}`. `"rls":"bypassed"` with status 503 means the app is connected as the owner: set `LUMA_DATABASE_URL` (step 4).
- GitHub → Actions → **Scheduled jobs**: runs every ~5 minutes and logs `{"ok":true,...}`. GitHub may delay scheduled runs, and disables them after 60 days without repository activity.
