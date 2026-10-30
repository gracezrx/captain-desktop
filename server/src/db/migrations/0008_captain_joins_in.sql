-- Captain joins a group chat on its own when it can help (on unless a chat
-- turns it off), and the runs it starts that way are marked.
alter table channels add column if not exists captain_joins_in boolean not null default true;
alter table runs add column if not exists unprompted boolean not null default false;
