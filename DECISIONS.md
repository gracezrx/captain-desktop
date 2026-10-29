# Decisions to review

Grace asked me to keep building and pick the recommended option whenever a question came up. These are those choices, so you can change any of them. Each one says where it lives in the code or settings.

Most are a setting or a few lines. The ones marked **★** shape the product the most, so read those first.

## Architecture

| # | Choice | Why | To change it |
| --- | --- | --- | --- |
| A1 ★ | **Our own backend, built the way Mattermost is built, without Mattermost's code.** We copied the design: the API → app → store layers, numbered migrations, the WebSocket hub with sequence numbers and replay, bots as users, hooks before and after a message is saved, buttons on messages, and unread counters on the membership row. No Mattermost code is in this repo, so its AGPL license doesn't apply. | You asked for a product you own end to end, with agents and routing built in, not a Mattermost add-on. | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps each Mattermost idea to our file. |
| A2 ★ | **One service plus Postgres.** API, web app, real-time, and agent workers run in one Node process. To scale, run more copies: real-time events cross between them over Postgres `LISTEN/NOTIFY`, and agent work is a job queue in Postgres. There's no Redis and no separate queue. | It's simpler to run and has fewer parts to break. It also matches Captain's "modular monolith first" rule (development standards 6.1). | `WORKERS=false` on some instances turns them into API-only nodes. |
| A3 | **TypeScript on Node 22 (Fastify, postgres.js, zod)**, not Go like Mattermost. | The server and app share one type file (`server/src/shared/types.ts`), and one language covers the whole stack. | — |
| A4 | **One repo** with `server/` and `desktop/`. The server also serves the web app at `/`, so testers can use a browser and skip the install. | Shipping the client and server together prevents version mismatch. | `WEB_DIST` points at another build, or leave it empty for API only. |
| A5 | Uploads are stored **on local disk** (a mounted volume). The storage interface is small, so S3 can slot in later. | One less service to set up. | `server/src/files/storage.ts` |
| A6 | **Supabase is used as plain Postgres**, through its session pooler. The server keeps its own accounts and doesn't use Supabase Auth, Storage or client keys. It turns on row-level security (with no policies) on all its tables, so Supabase's public Data API can't read them. | One database to manage, and it works the same on any Postgres. | `server/src/db/migrate.ts`, [DEPLOY.md](docs/DEPLOY.md#with-supabase-as-the-database) |

## Accounts and workspaces

| # | Choice | To change it |
| --- | --- | --- |
| B1 ★ | **Open sign-up.** Anyone can create an account. Signing up without an invite creates a workspace named from the "Team name" field. | `OPEN_SIGNUP=false` makes the server invite-only. |
| B2 | Invite links last **14 days** with unlimited uses. Only admins can make links that never expire; members' links last at most 30 days. Admins can invite admins; members can invite members and guests. Removing someone revokes their invite links, removes them from every channel, and makes their links stop working. | `app/workspaces.ts` → `makeInvite`, `removeMember` |
| B3 | Four roles: **owner, admin, member, guest**. Guests: <ul><li>see only channels they're added to</li><li>can't create channels</li><li>can't approve agent actions</li></ul> A workspace always has at least one owner. | `app/permissions.ts`, `app/workspaces.ts` |
| B4 | Sessions last **30 days** and extend while in use. Passwords use scrypt; tokens are stored only as hashes. Changing your password signs out your other devices. | `SESSION_DAYS` |
| B5 | Rate limits are 600 requests a minute per person and 20 sign-in attempts a minute per IP, kept in memory on each instance. Client IPs are taken from `X-Forwarded-For` only as far as the number of proxies you declare, so the header can't be forged to get around the limit. | `RATE_LIMIT_PER_MINUTE`, `AUTH_RATE_LIMIT_PER_MINUTE`, `TRUST_PROXY` (set `1` behind one load balancer) |
| B5b | Signing out or changing your password closes that session's open connections right away on the same server, and within 30 seconds on other servers. | `realtime/hub.ts` |
| B6 | **Password reset**, two ways: "Forgot password?" emails a link that works for an hour (when `SMTP_URL` is set), or an admin makes a one-time link in Settings → People that works for 24 hours. Only owners can reset admins' and owners' passwords. An admin's link works only for accounts in that workspace alone, and never for the people who run the server, since an account spans workspaces. Using a link signs the person out everywhere else. | `app/passwords.ts` |
| B7 | **Not built yet:** <ul><li>email verification</li><li>SSO</li><li>account deletion</li></ul> | Add email verification before a wide open launch. |
| B8 ★ | **Who runs the server:** exactly the people listed in `INSTANCE_ADMINS`, or, when it's empty, the first person to sign up. Only they set model keys, which every workspace on the server shares. Workspace owners and admins still set each workspace's budget. Emails aren't verified yet, so sign up with a listed address right after deploying. |
| B9 | **The Render Blueprint is invite-only** (`OPEN_SIGNUP=false`), and the first person can always sign up. Model keys are shared and paid by whoever runs the server, so open sign-up on a public address would let strangers spend that credit. | `OPEN_SIGNUP` in `render.yaml` or the Render dashboard | `INSTANCE_ADMINS`; `store/users.ts` → `isInstanceAdmin` |

## Chat

| # | Choice | To change it |
| --- | --- | --- |
| C1 ★ | **Threads stay collapsed, the way Slack does it.** The chat shows each thread's first message with "N replies". Replies open in a pane on the right. When you @mention an agent in a channel, its thread opens automatically. | `desktop/src/dashboard/ChatView.tsx` |
| C2 | In a DM, every message counts toward your badge, as it does in Mattermost. | `app/posts.ts` → `savePost` |
| C3 | You can edit only your own messages. Owners and admins can delete anyone's. No edit history is kept. | `app/posts.ts` |
| C4 | Uploads: up to **25 MB**. Signed links last about a day, so they work in `<img>`. Pictures show inline; other files download, and the server sandboxes them. | `MAX_UPLOAD_MB`, `FILE_LINK_MINUTES` |
| C5 | Search covers words and prefixes in the channels you belong to. | `store/posts.ts` → `searchPosts` |
| C6 | Real-time: a reconnect within 2 minutes replays up to 256 missed events. After a longer gap, the app reloads its state. | `realtime/hub.ts` |
| C7 | **Not built yet:** <ul><li>group DMs with three or more people (create a private channel instead)</li><li>pinned messages</li><li>custom emoji</li><li>link previews</li><li>message edit history</li></ul> | — |

## Agents and orchestration

| # | Choice | To change it |
| --- | --- | --- |
| D1 ★ | Every new workspace starts with **five agents**: Captain (coordinator), Researcher, Writer, Analyst and Designer. Each is a bot member of #general. Admins can edit them, turn them off (all except Captain), or add new ones in Settings → Agents. | `agents/builtins.ts` |
| D2 ★ | **When an agent answers:** <ul><li>a DM to it</li><li>an @mention (up to 3 agents per message)</li><li>a reply in a thread an agent was working in</li></ul> The thread case applies even when people are only talking to each other there. Agents never answer other agents' messages, so they can't loop. | `agents/triggers.ts` |
| D3 | Mentioning an agent that isn't in the channel adds it, private channels included. | `agents/triggers.ts` |
| D4 | Replies go in the conversation in a DM, and in the message's thread in a channel. When a plan starts in a DM, its steps go in the plan card's thread, which keeps the DM tidy. | `agents/triggers.ts`, `orchestrator.ts` → `workRoot` |
| D5 ★ | **How @captain works:** <ul><li>It answers directly or makes a plan of 2–6 steps for the specialists.</li><li>Short small talk skips planning.</li><li>Steps run in parallel when they don't depend on each other, up to 3 at once.</li><li>Each step sees the outputs of the steps it depends on.</li><li>Captain combines the results into one answer.</li><li>If a step fails, the steps that depend on it are skipped, and the answer says so.</li></ul> | `AGENT_MAX_PARALLEL`, `AGENT_MAX_PLAN_STEPS`, `agents/planner.ts` |
| D6 ★ | **Approvals.** Sending email and `request_approval` always stop for a person. The person who asked or a workspace admin can approve; nobody else can. A card expires if its run is stopped; otherwise it waits indefinitely. | `agents/tools/actions.ts` (`external: true`), `orchestrator.ts` → `decide` |
| D7 | The person who asked, or an admin, can stop a run (the Stop button on the plan card). | `app/agents.ts` → `cancelRun` |
| D8 ★ | **Agents see only what the person who asked can see, and quote only what everyone in the conversation can see.** <ul><li>Workspace search and channel reads use the asker's memberships.</li><li>A source is used only if every person in the conversation where the answer will be posted is already a member of it, or it's public and nobody there is a guest.</li><li>In your own DM with an agent, it can use everything you can read.</li></ul> | `agents/tools/workspace.ts` → `shareableIn` |
| D9 | **What an agent reads:** <ul><li>in a thread: the thread, up to the last 40 messages</li><li>in a DM: the last 24 messages</li><li>at the top of a channel: the last 10 messages from the past 6 hours, as background</li><li>images from the last 3 messages, for vision models</li><li>text files, inlined up to 20k characters</li></ul> PDFs aren't read yet. | `agents/history.ts` |
| D10 | **Tools:** <ul><li>workspace search and channel read</li><li>web search: needs `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY`, otherwise hidden</li><li>read a URL: public addresses on ports 80 and 443 only, up to 2 MB, checked at connection time. A link nobody shared (not in a person's message or a search result) needs a person's approval first, because a made-up address can carry information out.</li><li>create a Markdown document, attached to the reply</li><li>ask another agent</li><li>request approval</li><li>send email</li></ul> | `agents/tools/` |
| D11 | Email is real SMTP when `SMTP_URL` is set. Without it, an approved email isn't sent and the agent says so. The approval card shows exactly what will be sent. Mail goes out as "*Name* via Captain" with replies going to the person who asked, capped at 100 recipients per workspace per day. Approved actions run at most once, even if a server crashes mid-way. | `SMTP_URL`, `MAIL_FROM`, `EMAIL_DAILY_LIMIT` |
| D12 | An agent gets at most 6 tool rounds per reply, then must answer. | `AGENT_MAX_TOOL_ROUNDS` |

## Model routing and spend

| # | Choice | To change it |
| --- | --- | --- |
| E1 ★ | **The model list is copied from Captain's Smart Router**, with the same ids, tiers and priorities. **The prices in `config/models.json` are my estimates. Check them before you trust the spend numbers.** | `server/config/models.json` |
| E2 ★ | **Each model has routes in order:** the vendor's own API first, then OpenRouter, then any OpenAI-compatible gateway (for example, Captain's Yunwu account). A model is usable as soon as any one of its providers has a key, so `OPENROUTER_API_KEY` alone covers everything. | the `routes` lists in `models.json` |
| E3 | **Picking a tier for a request:** <ul><li>An agent's tier is the floor. For example, Analyst always works at "hard".</li><li>"auto" lets the request decide.</li><li>Quick heuristics raise it for long or demanding requests.</li><li>An optional cheap-model classifier is off by default.</li></ul> | `ROUTER_LLM_CLASSIFIER=true`, `llm/classify.ts` |
| E4 | **Fallback:** <ul><li>The router tries the tier's models by priority, then lower tiers, then higher ones.</li><li>It needs a vision model when images are attached, and tool support when tools are used.</li><li>A model and provider pair that fails 3 times is skipped for 2 minutes, tracked per instance.</li></ul> | `llm/router.ts` |
| E5 | **Spend:** <ul><li>Each workspace can set a monthly budget, reset on the 1st (UTC). There's no budget by default.</li><li>Past the budget, agents stop with a clear message and no model is called.</li><li>Only admins see spend.</li><li>Every call is recorded with its tokens, cost and latency.</li></ul> | Settings → Models & spend |
| E6 | With no model key at all, a **demo model** answers, marked as demo. You can click through plans, approvals and documents before adding keys. | `LLM_DEMO_FALLBACK=false` turns it off. |
| E7 ★ | **Model keys are pasted in the app** (Settings → Models & spend), with OpenRouter first and the other providers folded away. <ul><li>Saving sends a tiny request to the provider's cheapest model; a key the provider rejects isn't saved.</li><li>Keys are encrypted with `APP_SECRET` and only their last four characters are shown.</li><li>A key saved in Settings wins over the environment variable.</li><li>Each change reaches every instance within a second.</li></ul> Keys are per server, not per workspace. | `server/src/app/admin.ts`, `server/src/llm/keys.ts`. Per-workspace keys (each team pays its own provider) would be a follow-up. |

## The app

| # | Choice | To change it |
| --- | --- | --- |
| F1 | **Look:** the light, young direction you approved. <ul><li>Manrope</li><li>a frosted menu bar panel</li><li>Captain's animal portraits for agents</li><li>colored initials for people</li><li>gold for decisions</li></ul> It follows the system's dark mode. | `desktop/src/styles/app.css` |
| F2 | **Banners** fire for: <ul><li>mentions</li><li>DMs</li><li>decisions you can make</li><li>an agent finishing a reply in your DM or in a thread you started</li></ul> Clicking a banner opens that thread in the panel. | `desktop/src/lib/realtime.ts` |
| F3 | The Mac app's default server is set at build time (`VITE_CAPTAIN_URL`), and anyone can change it on the sign-in screen. | `desktop/src/lib/api.ts` |
| F4 | The sidebar lists every agent in the workspace, whether or not you've messaged it. Clicking one opens your DM with it. | `desktop/src/dashboard/Sidebar.tsx` |

## Open questions only you can answer

1. **Pricing and limits for testers:** should each workspace start with a budget, such as $20 a month, instead of none?
2. **Who can approve:** is "the person who asked, or an admin" right, or should any member be able to approve in shared channels?
3. **Repo home and license:** this is meant for `gracezrx/captain-desktop` (private, no license). Create the empty repo and I'll push. Choose a license before making it public.
4. **Team rules:** the Captain development standards (6.1) favor one codebase. This is a separate product in your personal account, as you asked; check with Lisen whether that's fine or whether it should move under Quest1120 later.
