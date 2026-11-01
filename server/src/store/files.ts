import type {Db} from '../db/index.js';
import type {FileProps} from '../shared/types.js';
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
    props: FileProps;
    createdAt: number;
};

export async function insertFile(db: Db, f: Omit<FileRow, 'id' | 'createdAt' | 'postId' | 'props'> & {id?: string; props?: FileProps}): Promise<FileRow> {
    const [row] = await db`
        insert into files (id, workspace_id, channel_id, user_id, name, mime, size, width, height, storage_key, props, created_at)
        values (${f.id ?? newId()}, ${f.workspaceId}, ${f.channelId}, ${f.userId}, ${f.name}, ${f.mime}, ${f.size}, ${f.width}, ${f.height}, ${f.storageKey}, ${db.json((f.props ?? {}) as never)}, ${now()})
        returning *`;
    return row as unknown as FileRow;
}

// Add to what a file's card shows (its Google copy, say).
export async function updateFileProps(db: Db, id: string, props: FileProps): Promise<void> {
    await db`update files set props = props || ${db.json(props as never)} where id = ${id}`;
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
