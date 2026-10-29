# Captain Desktop

Captain is a group chat where your team and its AI agents work together. Ask **@captain** for something big and it:

- plans the work
- hands each part to the right agent and the right model
- runs the parts in parallel
- posts one answer

Anything that leaves the workspace, such as an email, waits for a person to approve it.

It comes in four parts:

- **A Mac app**: a dashboard window, plus a frosted panel that drops down from the menu bar. Press **⌘⇧Space** anywhere to write to any chat, snap your screen, talk instead of type, or approve what an agent wants to do. A little floating face talks with you: hold it, or hold **⌃⇧Space**, ask Captain something, and it answers out loud. The app can run the Captain server itself, so nothing else needs installing.
- **A Chrome extension**: a toolbar popup and a side panel with the same compact view. It can send the page you're on, selected text or a screenshot to a chat, let agents read the page when you click, and approve decisions.
- **A web app** with the same interface, so testers can use a browser.
- **A server** that does everything else: accounts, workspaces, chat, real time, model routing and multi-agent orchestration. It runs inside the Mac app, or hosted for a whole team.

![Dashboard](docs/screenshots/dashboard.png)

| Agents work in threads, and ask before acting | Decide from the menu bar |
| --- | --- |
| ![Thread with a decision](docs/screenshots/thread-decision.png) | ![Panel: decision](docs/screenshots/panel-decision.png) |

| Write from anywhere | What needs you |
| --- | --- |
| ![Panel: write](docs/screenshots/panel-write.png) | ![Panel: inbox](docs/screenshots/panel-inbox.png) |

## What it does

- **Workspaces and people**
  - Sign up, sign in, invite people with links, and reset a forgotten password.
  - Roles: owner, admin, member, guest.
  - One account can belong to several workspaces.
- **Chat**
  - Channels (public or private), direct messages and threads.
  - Reactions, files and screenshots, search.
  - Unread counts and mentions.
  - Real-time updates that survive reconnects.
- **Agents**
  - Five built-in agents: Captain, Researcher, Writer, Analyst and Designer.
  - Admins can add and edit agents: instructions, tools, difficulty tier, a pinned model.
  - Mention an agent with `@`, or message it directly.
- **Orchestration**
  - Captain answers directly, or splits the work into steps for the specialists.
  - Steps run in parallel when they can; later steps receive earlier results.
  - A live plan card shows progress and has a Stop button.
  - Steps can hand questions to each other.
  - Agent replies stream in as they're written.
- **Approvals**
  - Email, and anything an agent marks as needing sign-off, becomes a decision card.
  - The work pauses and resumes exactly where it stopped, after Approve or Reject.
- **Model routing**, following Captain's Smart Router:
  - Three difficulty tiers, with priorities, vision and tool support.
  - Several provider routes per model, falling back automatically, and skipping models that keep failing.
  - Monthly budgets and a cost ledger per workspace.
  - Model keys pasted in Settings by whoever runs the server, stored encrypted and tried before they're saved.
- **Mac-only features**
  - menu bar panel and global shortcut
  - screen and region snapshots
  - voice typing (English or Chinese)
  - banners that open the right thread
  - the session kept in the Keychain

## Get it

- **Mac app:** download `Captain.dmg` from the [app-latest release](../../releases/tag/app-latest), drag Captain to Applications, and right-click → Open the first time. On first launch, paste your database address (or your server `.env`) and Captain starts its own server.
- **Chrome extension:** download `Captain-Chrome-extension.zip` from the same release, unzip it, open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked**.

GitHub builds both on a Mac whenever someone runs **Actions → Mac app → Run workflow**.

## Run it from source

```bash
createdb captain
cd server && npm install && npm run dev        # API on :8080, migrations run automatically
cd desktop && npm install && npm run dev       # app on http://localhost:1420
```

Create an account in the browser. With no model key set, agents answer in **demo mode**, so plans, approvals and documents still work. For real answers, paste an OpenRouter key in **Settings → Models & spend**: the first account on a server runs it and sees that card. `OPENROUTER_API_KEY` in `server/.env` works too.

The server runs on any Postgres 14 or newer, including Supabase ([docs/DEPLOY.md](docs/DEPLOY.md#with-supabase-as-the-database)).

- **Deploying**: Supabase, Docker Compose, Render, model keys, all settings, and building and signing the Mac app are in [docs/DEPLOY.md](docs/DEPLOY.md).
- **How it's built**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Product choices to review**: [DECISIONS.md](DECISIONS.md).

## Repo

| Folder | What it is | Stack |
| --- | --- | --- |
| `server/` | The backend: REST API, WebSocket, job workers, model router, agents. Also serves the web app. | Node 22, TypeScript, Fastify, Postgres (postgres.js), zod |
| `server/config/models.json` | The model catalog: tiers, priorities, prices, provider routes. | |
| `server/test/` | Integration tests against a real Postgres and scripted model providers. | `node:test` |
| `desktop/` | The app: dashboard, menu bar panel, native core (including the built-in server's launcher). | Tauri 2 (Rust), React 19, Tailwind 4, Zustand |
| `desktop/extension`, `desktop/src/extension` | The Chrome extension: manifest, popup and side panel pages, background worker. It reuses the menu bar panel's code. | Manifest V3 |
| `Dockerfile`, `docker-compose.yml`, `render.yaml` | One image with the API and the web app; Compose and Render setups. | |

## Tests

```bash
cd server && npm test     # needs a captain_test database
```

The 65 tests cover:

- accounts, invites, roles and password resets
- private channels and DMs
- threads, unread counts and file links
- WebSocket replay after a reconnect
- plans with parallel steps, approvals (who may decide, approve, reject, expire), stopping a run
- routing by tier, fallback and the circuit breaker
- streaming and tool calls
- vision routing, budgets
- model keys: who may set them, encryption, a rejected key not being saved, Settings winning over the environment, every instance picking up a change, and the server admin's account being safe from workspace owners
- database addresses (TLS for Supabase, the transaction pooler warning) and row-level security on every table
- the job queue's retries and recovery
- security: what agents may quote where, links that need approval, blocked private addresses, approvals that run once, revoked invites and sessions, forged client addresses

## Background

Captain started on Mattermost. This version keeps Mattermost's design and uses none of its code. What we kept:

- the API → app → store layers
- numbered migrations
- the WebSocket protocol with sequence numbers and replay
- bots as users
- hooks before and after a message is saved
- buttons on messages
- unread counters on the channel membership

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) shows where each idea lives.
