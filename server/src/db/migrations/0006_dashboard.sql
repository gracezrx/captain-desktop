-- For the Home dashboard: recent runs in a workspace, and tokens per run.
create index if not exists runs_workspace_updated on runs(workspace_id, updated_at desc);
create index if not exists usage_run on usage_events(run_id) where run_id is not null;
