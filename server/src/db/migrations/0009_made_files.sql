-- Files Captain makes carry what their card shows: the kind of file, its
-- length, the Google copy and the PDF that came with it.
alter table files add column if not exists props jsonb not null default '{}'::jsonb;

-- A decision nobody answered is reminded once, after a day.
alter table approvals add column if not exists reminded_at bigint;

-- The Drive folders Captain files new Google files in: "Captain" (chat '')
-- and one per chat inside it, per person and workspace (their Composio user).
create table if not exists google_folders (
    composio_user text not null,
    channel_id    text not null default '',
    folder_id     text not null,
    primary key (composio_user, channel_id)
);

-- Agents that write documents can now make decks and spreadsheets too
-- (and anyone can switch those off per agent afterwards).
update agents set tools = tools || array['create_presentation', 'create_spreadsheet']::text[]
where 'create_document' = any(tools) and not ('create_presentation' = any(tools));

-- Token use per chat: the chat each model call was for (backfilled from runs).
alter table usage_events add column if not exists channel_id text references channels(id) on delete set null;
update usage_events u set channel_id = r.channel_id from runs r where u.run_id = r.id and u.channel_id is null;
create index if not exists usage_channel on usage_events(channel_id, created_at desc) where channel_id is not null;
