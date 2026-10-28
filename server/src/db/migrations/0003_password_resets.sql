-- Password resets: a one-time link, emailed to the person or made by a
-- workspace admin. Only a hash of the token is stored.
create table password_resets (
    id          text primary key,
    user_id     text not null references users(id) on delete cascade,
    token_hash  text not null unique,
    created_by  text references users(id),
    created_at  bigint not null,
    expires_at  bigint not null,
    used_at     bigint
);
create index password_resets_user on password_resets(user_id);
