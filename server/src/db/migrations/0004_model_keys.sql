-- Model provider keys pasted in Settings (encrypted with APP_SECRET), and the
-- people who run this server and may set them.
alter table users add column instance_admin boolean not null default false;

-- On a server that already has people, the first one to sign up runs it.
update users set instance_admin = true
where id = (select id from users where not is_bot and deleted_at is null order by created_at limit 1);

create table provider_keys (
    provider_id  text primary key,
    secret       text not null,
    last4        text not null,
    base_url     text,
    updated_by   text references users(id) on delete set null,
    updated_at   bigint not null
);
