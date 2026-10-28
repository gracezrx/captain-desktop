import type {Db} from '../db/index.js';
import type {User} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type UserRow = {
    id: string;
    email: string | null;
    username: string;
    displayName: string;
    passwordHash: string | null;
    isBot: boolean;
    agentId: string | null;
    portrait: string | null;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    lastActiveAt: number | null;
};

export function toUser(r: UserRow, opts: {includeEmail?: boolean} = {}): User {
    return {
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        ...(opts.includeEmail && r.email ? {email: r.email} : {}),
        isBot: r.isBot,
        agentId: r.agentId,
        portrait: r.portrait,
        createdAt: r.createdAt,
    };
}

export async function createUser(db: Db, u: {email: string | null; username: string; displayName: string; passwordHash: string | null; isBot?: boolean; agentId?: string | null; portrait?: string | null}): Promise<UserRow> {
    const t = now();
    const [row] = await db`
        insert into users (id, email, username, display_name, password_hash, is_bot, agent_id, portrait, created_at, updated_at)
        values (${newId()}, ${u.email}, ${u.username}, ${u.displayName}, ${u.passwordHash}, ${u.isBot ?? false}, ${u.agentId ?? null}, ${u.portrait ?? null}, ${t}, ${t})
        returning *`;
    return row as unknown as UserRow;
}

export async function getUser(db: Db, id: string): Promise<UserRow | null> {
    const [row] = await db`select * from users where id = ${id} and deleted_at is null`;
    return (row as unknown as UserRow) ?? null;
}

export async function getUsers(db: Db, ids: string[]): Promise<UserRow[]> {
    if (!ids.length) {
        return [];
    }
    return (await db`select * from users where id = any(${ids}) and deleted_at is null`) as unknown as UserRow[];
}

export async function getUserByLogin(db: Db, login: string): Promise<UserRow | null> {
    const [row] = await db`select * from users where (email = ${login} or username = ${login}) and deleted_at is null and is_bot = false limit 1`;
    return (row as unknown as UserRow) ?? null;
}

export async function usernameTaken(db: Db, username: string): Promise<boolean> {
    const [row] = await db`select 1 from users where username = ${username}`;
    return Boolean(row);
}

export async function updateUser(db: Db, id: string, patch: {displayName?: string; passwordHash?: string; portrait?: string | null; agentId?: string | null}): Promise<UserRow> {
    const [row] = await db`
        update users set
            display_name = coalesce(${patch.displayName ?? null}, display_name),
            password_hash = coalesce(${patch.passwordHash ?? null}, password_hash),
            portrait = case when ${patch.portrait !== undefined} then ${patch.portrait ?? null} else portrait end,
            agent_id = case when ${patch.agentId !== undefined} then ${patch.agentId ?? null} else agent_id end,
            updated_at = ${now()}
        where id = ${id}
        returning *`;
    return row as unknown as UserRow;
}

export async function touchActive(db: Db, id: string): Promise<void> {
    await db`update users set last_active_at = ${now()} where id = ${id}`;
}

// A free username based on a wish: "grace", then "grace2", "grace3"...
export async function freeUsername(db: Db, wish: string): Promise<string> {
    const base = wish.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 20) || 'user';
    for (let i = 1; i < 1000; i++) {
        const candidate = i === 1 ? base : `${base}${i}`;
        if (!(await usernameTaken(db, candidate))) {
            return candidate;
        }
    }
    return `${base}${newId().slice(0, 6)}`;
}
