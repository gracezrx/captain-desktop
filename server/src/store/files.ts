import type {Db} from '../db/index.js';
import {newId, now} from '../util/ids.js';

export type FileRow = {
    id: string;
    workspaceId: string;
    channelId: string | null;
    userId: string;
    postId: string | null;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    storageKey: string;
    createdAt: number;
};

export async function insertFile(db: Db, f: Omit<FileRow, 'id' | 'createdAt' | 'postId'> & {id?: string}): Promise<FileRow> {
    const [row] = await db`
        insert into files (id, workspace_id, channel_id, user_id, name, mime, size, width, height, storage_key, created_at)
        values (${f.id ?? newId()}, ${f.workspaceId}, ${f.channelId}, ${f.userId}, ${f.name}, ${f.mime}, ${f.size}, ${f.width}, ${f.height}, ${f.storageKey}, ${now()})
        returning *`;
    return row as unknown as FileRow;
}

export async function getFile(db: Db, id: string): Promise<FileRow | null> {
    const [row] = await db`select * from files where id = ${id}`;
    return (row as unknown as FileRow) ?? null;
}

export async function getFiles(db: Db, ids: string[]): Promise<FileRow[]> {
    if (!ids.length) {
        return [];
    }
    return (await db`select * from files where id = any(${ids})`) as unknown as FileRow[];
}

export async function attachFiles(db: Db, ids: string[], postId: string): Promise<void> {
    if (ids.length) {
        await db`update files set post_id = ${postId} where id = any(${ids}) and post_id is null`;
    }
}
