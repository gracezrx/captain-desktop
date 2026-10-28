import type {Db} from '../db/index.js';
import {newId, now} from '../util/ids.js';

export type SessionRow = {id: string; userId: string; tokenHash: string; createdAt: number; expiresAt: number; lastUsedAt: number};

export async function createSession(db: Db, s: {userId: string; tokenHash: string; expiresAt: number; userAgent?: string; ip?: string}): Promise<SessionRow> {
    const t = now();
    const [row] = await db`
        insert into sessions (id, user_id, token_hash, created_at, expires_at, last_used_at, user_agent, ip)
        values (${newId()}, ${s.userId}, ${s.tokenHash}, ${t}, ${s.expiresAt}, ${t}, ${s.userAgent ?? null}, ${s.ip ?? null})
        returning *`;
    return row as unknown as SessionRow;
}

export async function getSessionByHash(db: Db, tokenHash: string): Promise<SessionRow | null> {
    const [row] = await db`select * from sessions where token_hash = ${tokenHash} and expires_at > ${now()}`;
    return (row as unknown as SessionRow) ?? null;
}

// Sliding sessions: using one moves its expiry forward (at most once an hour).
export async function touchSession(db: Db, id: string, expiresAt: number): Promise<void> {
    await db`update sessions set last_used_at = ${now()}, expires_at = ${expiresAt} where id = ${id} and last_used_at < ${now() - 3_600_000}`;
}

export async function deleteSession(db: Db, id: string): Promise<void> {
    await db`delete from sessions where id = ${id}`;
}

export async function deleteUserSessions(db: Db, userId: string, exceptId?: string): Promise<void> {
    await db`delete from sessions where user_id = ${userId} and id <> ${exceptId ?? ''}`;
}

export async function deleteExpiredSessions(db: Db): Promise<number> {
    const r = await db`delete from sessions where expires_at < ${now()}`;
    return r.count;
}
