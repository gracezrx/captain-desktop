# Running Captain

## On your machine (development)

You need Node 22 and Postgres 14 or newer.

```bash
createdb captain                         # or: docker run -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
cd server
cp .env.example .env                     # optional: add OPENROUTER_API_KEY for real answers
npm install
npm run dev                              # http://localhost:8080 (API); applies migrations on start

cd ../desktop
npm install
npm run dev                              # http://localhost:1420 (app, talks to :8080)
```

- Open http://localhost:1420 and create an account. That makes your workspace, with #general and five agents.
- The menu bar panel's browser preview is at http://localhost:1420/panel.html.
- With no model key set, agents answer in **demo mode**. Plans, approvals and documents still work, so you can click through everything.

Run the tests with `cd server && npm test`. They need a `captain_test` database, and `TEST_DATABASE_URL` overrides its address. They exercise:

- accounts, invites and roles
- channels, threads, files and real-time replay
- orchestration: plans, approvals, stopping a run
- routing and fallback against scripted model providers
- the job queue

## With Docker Compose (one machine)

```bash
cp server/.env.example .env
# set APP_SECRET (openssl rand -hex 32), PUBLIC_URL, and at least one model key
docker compose up -d --build
open http://localhost:8080
```

This runs Postgres and the Captain image. The image holds the API, the web app, real-time updates and the agent workers. Data lives in two volumes: `pgdata` for the database and `files` for uploads.

## On Render

`render.yaml` is a Blueprint for one Docker web service with a 10 GB disk for uploads, plus a managed Postgres.

1. In Render: **New → Blueprint**, and pick this repo.
2. Fill in the values marked `sync: false`:
   - `PUBLIC_URL`
   - one model key, such as `OPENROUTER_API_KEY`
   - optionally `TAVILY_API_KEY` for web search
   - optionally `SMTP_URL` and `MAIL_FROM` for email
3. Deploy. Migrations run when the service starts, and the health check is `/readyz`.

Any host that runs a Docker image and gives it Postgres works the same way: Fly.io, Railway, a VM.

## Keys and settings

All settings are environment variables. `server/.env.example` lists each one with a note. To go live you need:

| Setting | What for |
| --- | --- |
| `APP_SECRET` | Signs file links. In production the server refuses to start without one. |
| `DATABASE_URL` | Postgres. |
| `PUBLIC_URL` | Used to build invite links. |
| One model key | `OPENROUTER_API_KEY` covers every model in the catalog. Vendor keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, …) are tried first for their own models. `LLM_GATEWAY_URL` with `LLM_GATEWAY_KEY` adds any OpenAI-compatible gateway. |

Optional:

| Setting | What for |
| --- | --- |
| `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` | Web search for agents. |
| `SMTP_URL`, `MAIL_FROM` | Agents send real email after approval. |
| `OPEN_SIGNUP=false` | Invite-only. |
| `TRUST_PROXY=1` | Behind one load balancer (Render, Fly, Railway). Leave `false` when the server is exposed directly. |
| `EMAIL_DAILY_LIMIT` | Email recipients per workspace per day (default 100). |
| `CORS_ORIGINS` | Browser origins other than the server itself and the Mac app. |

To add or reprioritize models, edit `server/config/models.json`. Check the prices there: they're estimates.

## The Mac app

You need macOS 13 or newer, Xcode command-line tools, Rust (`rustup`), and Node 22.

```bash
cd desktop
npm install
VITE_CAPTAIN_URL=https://captain.example.com npm run tauri build
# → src-tauri/target/release/bundle/macos/Captain.app and dmg/Captain_0.1.0_aarch64.dmg
```

- `VITE_CAPTAIN_URL` sets the server the app opens with; people can change it on the sign-in screen.
- `npm run tauri dev` runs the app against the dev server.
- On first use, macOS asks for Screen Recording (snapshots), Microphone and Speech Recognition (voice typing), and Notifications.

### Shipping to testers

Use your Apple Developer ID to sign and notarize, otherwise Gatekeeper blocks the app. Set these variables before `npm run tauri build`, and Tauri signs and notarizes:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD` (an app-specific password)
- `APPLE_TEAM_ID`

For a universal build that runs on Intel and Apple Silicon: `npm run tauri build -- --target universal-apple-darwin`.

## Operating it

- **Upgrades:** deploy the new image. Migrations apply at start under a lock, so several instances starting at once is safe. Never edit an applied migration; add a new numbered file.
- **Backups:** back up the database (managed Postgres does this daily) and the files disk.
- **Logs:**
  - The logs are JSON in production.
  - Each model call is in the `usage_events` table.
  - Security-relevant actions are in `audit_log`: sign-ins, role changes, approvals, deleted messages.
- **Scaling:** see [ARCHITECTURE.md](ARCHITECTURE.md#scaling-and-availability). Before running more than one instance, put uploads on shared storage.

### Before inviting people you don't know

- [ ] `APP_SECRET` is set and the site is on HTTPS.
- [ ] `TRUST_PROXY` matches your setup (`1` behind one load balancer), so sign-in limits apply per real client.
- [ ] Decide on `OPEN_SIGNUP`, and set a monthly budget per workspace (Settings → Models & spend).
- [ ] Set `SMTP_URL` so "Forgot password?" can email links; without it, admins make reset links in Settings → People.
