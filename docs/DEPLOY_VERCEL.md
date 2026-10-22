# Deploying a private review build on Vercel + Neon

## Quick start (zero configuration)

On a Vercel project with the **Neon integration** (Storage → Neon), just deploy `main`. The build command `vercel-build` (`scripts/vercel-setup.ts`) then does all of the following automatically:

- creates the non-owner runtime role `luma_app`;
- applies migrations;
- loads the demo data once.

At runtime the app derives everything else from the injected owner connection. The secrets are derived from the owner password and never printed:

| Value | Default |
|---|---|
| Database role | `luma_app` |
| `APP_ENV` | `review` |
| `AUTH_SECRET` | derived |
| Sandbox webhook secret | derived |
| `STORAGE_DRIVER` | `db` |
| On-screen codes | on |
| `APP_URL` | from the Vercel URL |

Any variable you set yourself wins. Set `LUMA_DATABASE_URL` to manage the database manually (the steps below), and `LUMA_SKIP_SEED=1` to skip demo data.

The demo data is fake. Review builds show verification codes on screen, so enable **Deployment Protection** (step 5) if the URL could be found by others.

Sign in through `/auth/recover` (step 6). Background jobs are optional here: expired holds are released whenever a booking or availability request touches them. Add `CRON_SECRET` plus the scheduled-jobs workflow for reminders and other sweeps.

The detailed manual setup follows.


This deploys LUMA as a **review build** (`APP_ENV=review`). The payment sandbox and
on-screen verification codes keep working, and the build is hardened like production:
secure cookies, mandatory admin MFA, and `noindex` on every page. It is **not** for
real customers. No real money moves and no messages are sent.

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
| `DEV_OTP_ECHO` | `true` (review builds show codes on screen; no SMS/email provider is connected) |
| `DEMO_MODE` | `false` |
| `PLATFORM_MFA_REQUIRED` | `true` (already enforced by `APP_ENV=review`) |
| `TRUSTED_PROXY_HOPS` | `1` |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | another random value |

Do **not** set `DATABASE_OWNER_URL` in Vercel: the app never needs owner rights. Then redeploy.

## 4b. Production branch

Vercel → Project → **Settings → Git → Production Branch** = `main`, then **Deployments → Redeploy** the latest `main` commit. A Vercel-styled page saying `404 NOT_FOUND` with an id like `bom1::…` comes from Vercel, not the app: there is no deployment at that address yet (wrong URL, or no production deployment).

## 5. Keep it private (recommended)

Vercel → Project → **Settings → Deployment Protection → Vercel Authentication**. Only people on your Vercel team can open the site.

Then create **Protection Bypass for Automation** and save its value as the GitHub secret `VERCEL_AUTOMATION_BYPASS_SECRET`, so scheduled jobs can still reach the app.

This matters because review builds show verification codes on screen: without protection, anyone with the URL could register, or reset a demo account's password.

## 6. First sign-in

1. Open `/auth/recover` on the site and enter a demo account, for example `owner@noura.demo`.
2. The code appears on screen (review build). Choose a new password.
3. For the LUMA admin (`admin@luma.demo`), do the same, then enrol MFA when asked.

Demo accounts: `admin@luma.demo` (platform owner), `reviewer@luma.demo`, `owner@noura.demo`, `manager@noura.demo`, `reception@noura.demo`, `sara@noura.demo` (specialist), `finance@noura.demo`, `lamar@lamar.demo` (independent expert), `customer@demo.test`, `restricted@demo.test`, `new@demo.test`.

Storefronts: `/s/noura-salon`, `/s/lamar-makeup`.

## Checks

- `GET /api/v1/health` returns `{"ok":true,"db":"up","rls":"enforced"}`. `"rls":"bypassed"` with status 503 means the app is connected as the owner: set `LUMA_DATABASE_URL` (step 4).
- GitHub → Actions → **Scheduled jobs**: runs every ~5 minutes and logs `{"ok":true,...}`. GitHub may delay scheduled runs, and disables them after 60 days without repository activity.
