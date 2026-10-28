-- Approvals run their action at most once, and a resumed step answers only
-- to the approval it is actually waiting for.
alter table run_steps add column waiting_approval_id text;
alter table approvals add column executed_at bigint;
alter table approvals add column result text;

-- Daily email caps look up recent sends per workspace.
create index audit_workspace_action on audit_log(workspace_id, action, created_at desc);
