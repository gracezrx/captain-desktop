-- The agents a person named in one message (two or more @mentions). Captain
-- coordinates just them, in one run, instead of each one working on its own.
-- Null: Captain picks from the whole team.
alter table runs add column team text[];
