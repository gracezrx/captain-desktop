-- MCP servers people connect (Granola, Notion, Linear, or any server by its
-- address). Each person connects their own, in a workspace; agents working
-- for that person get its tools. Tokens are stored encrypted.
create table if not exists mcp_connections (
    id             text primary key,
    workspace_id   text not null references workspaces(id) on delete cascade,
    user_id        text not null references users(id) on delete cascade,
    preset         text,
    name           text not null,
    url            text not null,
    auth_mode      text not null check (auth_mode in ('none', 'token', 'oauth')),
    auth_header    text,
    token          text,
    refresh_token  text,
    oauth          jsonb not null default '{}'::jsonb,
    status         text not null default 'unverified' check (status in ('connected', 'needs_sign_in', 'error', 'unverified')),
    last_error     text,
    tools          jsonb not null default '[]'::jsonb,
    enabled        boolean not null default true,
    verified_at    bigint,
    created_at     bigint not null,
    updated_at     bigint not null
);
create index if not exists mcp_connections_owner on mcp_connections(workspace_id, user_id);
