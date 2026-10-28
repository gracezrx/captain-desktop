-- Captain schema, version 1.
-- Conventions: 26-character text IDs, bigint Unix-millisecond timestamps,
-- soft deletes through deleted_at.

create extension if not exists citext;

-- ------------------------------------------------------------ people

create table users (
    id              text primary key,
    email           citext unique,
    username        citext not null unique,
    display_name    text not null,
    password_hash   text,
    is_bot          boolean not null default false,
    agent_id        text,
    portrait        text,
    created_at      bigint not null,
    updated_at      bigint not null,
    deleted_at      bigint,
    last_active_at  bigint
);

create table sessions (
    id            text primary key,
    user_id       text not null references users(id) on delete cascade,
    token_hash    text not null unique,
    created_at    bigint not null,
    expires_at    bigint not null,
    last_used_at  bigint not null,
    user_agent    text,
    ip            text
);
create index sessions_user on sessions(user_id);

-- ------------------------------------------------------------ workspaces

create table workspaces (
    id                  text primary key,
    name                text not null,
    slug                citext not null unique,
    created_by          text not null references users(id),
    created_at          bigint not null,
    updated_at          bigint not null,
    deleted_at          bigint,
    monthly_budget_usd  double precision,
    settings            jsonb not null default '{}'::jsonb
);

create table workspace_members (
    workspace_id  text not null references workspaces(id) on delete cascade,
    user_id       text not null references users(id) on delete cascade,
    role          text not null check (role in ('owner', 'admin', 'member', 'guest')),
    joined_at     bigint not null,
    primary key (workspace_id, user_id)
);
create index workspace_members_user on workspace_members(user_id);

create table invites (
    id            text primary key,
    workspace_id  text not null references workspaces(id) on delete cascade,
    token_hash    text not null unique,
    role          text not null check (role in ('admin', 'member', 'guest')),
    created_by    text not null references users(id),
    created_at    bigint not null,
    expires_at    bigint,
    max_uses      integer,
    uses          integer not null default 0,
    revoked_at    bigint
);
create index invites_workspace on invites(workspace_id);

-- ------------------------------------------------------------ chat

create table channels (
    id               text primary key,
    workspace_id     text not null references workspaces(id) on delete cascade,
    type             char(1) not null check (type in ('O', 'P', 'D', 'G')),
    name             text not null,
    display_name     text not null,
    purpose          text not null default '',
    created_by       text not null references users(id),
    created_at       bigint not null,
    updated_at       bigint not null,
    deleted_at       bigint,
    last_post_at     bigint not null default 0,
    total_msg_count  bigint not null default 0
);
-- Names are unique within a workspace; DMs use a deterministic name ("<idA>__<idB>").
create unique index channels_workspace_name on channels(workspace_id, name) where deleted_at is null;
create index channels_workspace on channels(workspace_id) where deleted_at is null;

create table channel_members (
    channel_id      text not null references channels(id) on delete cascade,
    user_id         text not null references users(id) on delete cascade,
    role            text not null default 'member' check (role in ('admin', 'member')),
    joined_at       bigint not null,
    last_viewed_at  bigint not null default 0,
    msg_count       bigint not null default 0,
    mention_count   bigint not null default 0,
    primary key (channel_id, user_id)
);
create index channel_members_user on channel_members(user_id);

create table posts (
    id             text primary key,
    channel_id     text not null references channels(id) on delete cascade,
    workspace_id   text not null references workspaces(id) on delete cascade,
    user_id        text not null references users(id),
    root_id        text references posts(id),
    type           text not null default '',
    message        text not null default '',
    props          jsonb not null default '{}'::jsonb,
    file_ids       text[] not null default '{}',
    pending_id     text,
    created_at     bigint not null,
    updated_at     bigint not null,
    edited_at      bigint,
    deleted_at     bigint,
    reply_count    integer not null default 0,
    last_reply_at  bigint,
    search         tsvector generated always as (to_tsvector('simple', coalesce(message, ''))) stored
);
create index posts_channel_created on posts(channel_id, created_at desc) where deleted_at is null;
create index posts_root on posts(root_id) where root_id is not null;
create index posts_search on posts using gin(search);
create index posts_workspace_created on posts(workspace_id, created_at desc);

create table reactions (
    post_id     text not null references posts(id) on delete cascade,
    user_id     text not null references users(id) on delete cascade,
    emoji       text not null,
    created_at  bigint not null,
    primary key (post_id, user_id, emoji)
);

create table files (
    id            text primary key,
    workspace_id  text not null references workspaces(id) on delete cascade,
    channel_id    text references channels(id) on delete set null,
    user_id       text not null references users(id),
    post_id       text references posts(id) on delete set null,
    name          text not null,
    mime          text not null,
    size          bigint not null,
    width         integer,
    height        integer,
    storage_key   text not null,
    created_at    bigint not null
);
create index files_post on files(post_id);

-- ------------------------------------------------------------ agents

create table agents (
    id              text primary key,
    workspace_id    text not null references workspaces(id) on delete cascade,
    user_id         text not null unique references users(id),
    handle          citext not null,
    name            text not null,
    description     text not null default '',
    instructions    text not null default '',
    tier            text not null default 'auto' check (tier in ('auto', 'easy', 'balanced', 'hard')),
    model           text,
    tools           text[] not null default '{}',
    portrait        text not null default 'fox',
    is_coordinator  boolean not null default false,
    enabled         boolean not null default true,
    builtin         boolean not null default false,
    created_at      bigint not null,
    updated_at      bigint not null,
    unique (workspace_id, handle)
);

-- A run is one piece of agent work started by a message: a single agent
-- answering, or Captain's plan of steps across several agents.
create table runs (
    id               text primary key,
    workspace_id     text not null references workspaces(id) on delete cascade,
    channel_id       text not null references channels(id) on delete cascade,
    root_post_id     text references posts(id),
    trigger_post_id  text references posts(id),
    requested_by     text not null references users(id),
    agent_id         text not null references agents(id),
    kind             text not null check (kind in ('single', 'plan')),
    status           text not null check (status in ('queued', 'planning', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
    goal             text not null default '',
    card_post_id     text references posts(id),
    result_post_id   text references posts(id),
    error            text,
    cost_usd         double precision not null default 0,
    created_at       bigint not null,
    updated_at       bigint not null
);
create index runs_channel on runs(channel_id, created_at desc);
create index runs_active on runs(status) where status in ('queued', 'planning', 'running', 'waiting_approval');

create table run_steps (
    run_id       text not null references runs(id) on delete cascade,
    id           text not null,
    idx          integer not null,
    agent_id     text not null references agents(id),
    title        text not null,
    instructions text not null,
    depends_on   text[] not null default '{}',
    status       text not null check (status in ('pending', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped', 'cancelled')),
    output       text,
    error        text,
    transcript   jsonb,           -- the agent's conversation so far, to resume after an approval
    post_id      text references posts(id),
    model_id     text,
    cost_usd     double precision not null default 0,
    started_at   bigint,
    finished_at  bigint,
    primary key (run_id, id)
);

create table approvals (
    id            text primary key,
    workspace_id  text not null references workspaces(id) on delete cascade,
    channel_id    text not null references channels(id) on delete cascade,
    run_id        text references runs(id) on delete cascade,
    step_id       text,
    post_id       text references posts(id),
    agent_id      text references agents(id),
    tool          text not null,
    args          jsonb not null,
    tool_call_id  text,
    title         text not null,
    reason        text not null default '',
    fields        jsonb not null default '[]'::jsonb,
    status        text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
    requested_by  text references users(id),
    decided_by    text references users(id),
    decided_at    bigint,
    created_at    bigint not null
);
create index approvals_pending on approvals(workspace_id) where status = 'pending';

-- ------------------------------------------------------------ models and spend

create table usage_events (
    id            text primary key,
    workspace_id  text not null references workspaces(id) on delete cascade,
    user_id       text references users(id),
    agent_id      text references agents(id),
    run_id        text references runs(id) on delete set null,
    step_id       text,
    model_id      text not null,
    provider      text not null,
    tier          text not null,
    purpose       text not null,
    tokens_in     integer not null default 0,
    tokens_out    integer not null default 0,
    cost_usd      double precision not null default 0,
    latency_ms    integer not null default 0,
    ok            boolean not null,
    error         text,
    created_at    bigint not null
);
create index usage_workspace_created on usage_events(workspace_id, created_at desc);

-- ------------------------------------------------------------ jobs

-- A small durable queue: workers claim jobs with FOR UPDATE SKIP LOCKED and
-- hold a lease they keep extending; a job whose lease runs out is picked up
-- again by another worker.
create table jobs (
    id            text primary key,
    kind          text not null,
    payload       jsonb not null,
    status        text not null check (status in ('queued', 'running', 'done', 'failed')),
    run_at        bigint not null,
    attempts      integer not null default 0,
    max_attempts  integer not null default 3,
    locked_by     text,
    locked_until  bigint,
    last_error    text,
    dedupe_key    text,
    created_at    bigint not null,
    updated_at    bigint not null
);
create index jobs_ready on jobs(run_at) where status in ('queued', 'running');
-- At most one waiting job per dedupe key (e.g. one queued "advance" per run).
create unique index jobs_dedupe on jobs(dedupe_key) where dedupe_key is not null and status = 'queued';

-- Real-time events too big for a Postgres NOTIFY payload, for other server nodes.
create table realtime_outbox (
    id          text primary key,
    payload     jsonb not null,
    created_at  bigint not null
);

-- ------------------------------------------------------------ audit

create table audit_log (
    id            text primary key,
    workspace_id  text,
    user_id       text,
    action        text not null,
    target        text,
    meta          jsonb not null default '{}'::jsonb,
    ip            text,
    created_at    bigint not null
);
create index audit_workspace on audit_log(workspace_id, created_at desc);
