# Captain Desktop

A lightweight Mac app for Captain group chats, where your team, AI agents and models work together. It has two parts: a dashboard window, and a frosted panel that drops down from the menu bar. Press **⌥⇧Space** from anywhere to write to any chat, attach a screen snapshot, talk instead of type, and approve what an agent wants to do without opening the dashboard.

The chat backend is a stock, unmodified [Mattermost](https://github.com/mattermost/mattermost) server. Captain's agents join it as bot accounts through a small Node service, the **Captain bridge**.

![Dashboard](docs/screenshots/dashboard.png)

| Write from the menu bar | Decide in place |
| --- | --- |
| ![Panel: write](docs/screenshots/panel-write.png) | ![Panel: decision](docs/screenshots/panel-decision.png) |

## What's in this repo

| Folder | What it is | Stack |
| --- | --- | --- |
| `desktop/` | The Mac app: dashboard window, menu bar panel, native core | Tauri 2 (Rust), React 19, Tailwind 4, `@mattermost/client` |
| `bridge/` | Runs Captain's agents as Mattermost bots: answers mentions and DMs, reads screenshots, turns risky actions into decision cards, handles Approve / Reject | Node 22, TypeScript, `ws` |
| `server/` | Docker Compose for Mattermost + Postgres + bridge, and a one-time setup script | Docker |
| `dev/` | A stand-in Mattermost server for UI work without Docker | Node |

## How it works

```
 Your Mac                                   Server (Docker)
┌──────────────────────────────┐          ┌───────────────────────────────┐
│ Menu bar icon  ⌥⇧Space        │          │ Mattermost (unchanged)         │
│ ┌──────────┐  ┌────────────┐ │  REST +   │  posts, threads, files, bots,  │
│ │Dashboard │  │ Menu bar   │ │ WebSocket │  real-time events, Postgres    │
│ │ window   │  │ panel      │ ├──────────►│                                │
│ └────┬─────┘  └─────┬──────┘ │           └──────┬───────────────▲─────────┘
│      └─ one connection ─┘     │       bot events │               │ button callbacks
│ Rust core: tray, hotkey,      │                  ▼               │
│ snapshot, banners, Keychain   │           ┌──────────────────────┴───┐
└──────────────────────────────┘           │ Captain bridge (agents)   │──► any OpenAI-compatible
                                           └──────────────────────────┘    model (Captain's router)
```

- The dashboard window holds the app's one WebSocket to Mattermost, even when it's closed (it hides). It relays events to the panel, raises banners, and sets the count next to the menu bar icon.
- An agent's reply that ends with a `DECISION: {...}` line becomes a **decision card**: a post of type `custom_captain_decision` with Approve / Reject buttons. A click goes from Mattermost to the bridge's `/actions` endpoint, which rewrites the card for everyone (for example "Approved by Grace · 11:02"). The agent then follows up.
- Agents don't answer other agents, so two bots can't loop.

## Try the UI in a browser (no Mac build, no Docker)

```bash
cd dev && npm install && npm start          # mock Mattermost on :8065
cd desktop && npm install && npm run dev    # http://localhost:1420
```

Sign in as `grace` / `captain`. The panel is at http://localhost:1420/panel.html. In a browser, the snapshot button draws a placeholder image, since only the Mac app can capture the screen.

To try the real bridge against the mock, start the mock with `npm start -- --bridge`, then:

```bash
cd bridge && npm install
AGENT_TOKENS="captain=bot-captain,researcher=bot-researcher,designer=bot-designer" npm start
```

## Run the real backend

Needs Docker Desktop and Node 22.

```bash
cd server
cp .env.example .env      # set the passwords, BRIDGE_SECRET, and your model endpoint
./start.sh                # Mattermost + Postgres, one-time setup, then the bridge
```

`setup.mjs` creates the admin account, a team, `#launch-room` and `#design-review`, and the `@captain`, `@researcher` and `@designer` bots. It also writes the bots' tokens to `.env`. To use real models, point `LLM_BASE_URL` / `LLM_API_KEY` at any OpenAI-compatible endpoint, such as Captain's router. Without one, the agents give placeholder replies.

## Run the Mac app

Needs macOS 13+, Xcode Command Line Tools (`xcode-select --install`), [Rust](https://rustup.rs) and Node 22.

```bash
cd desktop
npm install
npm run tauri dev         # development build with hot reload
npm run tauri build       # Captain.app and a .dmg in src-tauri/target/release/bundle/
```

On first use, macOS asks for **Screen Recording** (snapshots), **Microphone** and **Speech Recognition** (voice typing), and **Notifications**. Sign in with your server's address, for example `http://localhost:8065`.

| Shortcut | Does |
| --- | --- |
| ⌥⇧Space | Open the panel ready to write (press again to close) |
| Click the menu bar icon | Open the panel's inbox: what needs you |
| Camera button · ⌥-click | Snapshot the screen · drag a region instead |
| Hold ⌥ while typing, or hold the mic | Talk; let go to stop. Tap the mic for hands-free |
| ⏎ · ⇧⏎ · Esc | Send · new line · close (your draft is kept) |

## Status

Verified in this build:
- The dashboard and panel UI, driven in Chromium against the mock server. Covered: sign-in, chat list, unread and mention counts, sending text, snapshot upload, real-time delivery, the inbox, decision cards, and Approve.
- The bridge against the mock, with a stand-in model. Covered: replies in threads, reading attachments, creating decision cards from a `DECISION:` line, Approve / Reject through the callback, and refusing callbacks with the wrong secret.
- The Rust core compiles (`cargo check`) on Linux, and its macOS-only calls were checked against the crates' sources.

Not yet run, and the first things to check on a Mac:
- The native Mac pieces: the frosted panel under the menu bar icon, ⌥⇧Space, snapshots, clicking a banner to open its thread, and the Keychain.
- Voice typing inside the Mac app. It uses WebKit's speech recognition. If WebKit doesn't offer it, the plan is a small native bridge to Apple's Speech framework, with ElevenLabs as an opt-in.
- `server/setup.mjs` and the Compose stack against a live Mattermost. The mock doesn't implement the admin endpoints.
- The panel uses a standard always-on-top window. Floating over full-screen apps may need a native panel window (`tauri-nspanel`).

## Licensing

This repo doesn't copy or modify Mattermost's server code. Mattermost runs unmodified as a separate server, and the app talks to it only through `@mattermost/client` and `@mattermost/types`, which are published under MIT. Check with a lawyer before relying on this for distribution; it's a reading of the licenses, not legal advice. Captain's brand assets (`desktop/public`) belong to Quest Space.
