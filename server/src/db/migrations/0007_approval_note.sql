-- "Change it" on a decision: the change the person asked for when turning a
-- draft down. The agent gets it with the rejection and asks again.
alter table approvals add column if not exists note text;
