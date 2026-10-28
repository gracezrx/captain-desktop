import type {Db} from '../db/index.js';
import type {PostProps, PostType} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type PostRow = {
    id: string;
    channelId: string;
    workspaceId: string;
    userId: string;
    rootId: string | null;
    type: PostType;
    message: string;
    props: PostProps;
    fileIds: string[];
    pendingId: string | null;
    createdAt: number;
    updatedAt: number;
    editedAt: number | null;
    deletedAt: number | null;
    replyCount: number;
    lastReplyAt: number | null;
};

const COLS = 'id, channel_id, workspace_id, user_id, root_id, type, message, props, file_ids, pending_id, created_at, updated_at, edited_at, deleted_at, reply_count, last_reply_at';

export async function insertPost(db: Db, p: {channelId: string; workspaceId: string; userId: string; rootId?: string | null; type?: PostType; message: string; props?: PostProps; fileIds?: string[]; pendingId?: string | null; id?: string}): Promise<PostRow> {
    const t = now();
    const [row] = await db`
        insert into posts (id, channel_id, workspace_id, user_id, root_id, type, message, props, file_ids, pending_id, created_at, updated_at)
        values (${p.id ?? newId()}, ${p.channelId}, ${p.workspaceId}, ${p.userId}, ${p.rootId ?? null}, ${p.type ?? ''}, ${p.message},
                ${db.json((p.props ?? {}) as never)}, ${p.fileIds ?? []}, ${p.pendingId ?? null}, ${t}, ${t})
        returning ${db.unsafe(COLS)}`;
    if (p.rootId) {
        await db`update posts set reply_count = reply_count + 1, last_reply_at = ${t} where id = ${p.rootId}`;
    }
    return row as unknown as PostRow;
}

export async function getPost(db: Db, id: string): Promise<PostRow | null> {
    const [row] = await db`select ${db.unsafe(COLS)} from posts where id = ${id}`;
    return (row as unknown as PostRow) ?? null;
}

export async function getPosts(db: Db, ids: string[]): Promise<PostRow[]> {
    if (!ids.length) {
        return [];
    }
    return (await db`select ${db.unsafe(COLS)} from posts where id = any(${ids})`) as unknown as PostRow[];
}

// Newest first, before an optional cursor (a post's created_at).
export async function listChannelPosts(db: Db, channelId: string, opts: {before?: number; limit: number}): Promise<PostRow[]> {
    return (await db`
        select ${db.unsafe(COLS)} from posts
        where channel_id = ${channelId} and deleted_at is null and created_at < ${opts.before ?? Number.MAX_SAFE_INTEGER}
        order by created_at desc limit ${opts.limit}`) as unknown as PostRow[];
}

export async function listThread(db: Db, rootId: string): Promise<PostRow[]> {
    return (await db`
        select ${db.unsafe(COLS)} from posts
        where (id = ${rootId} or root_id = ${rootId}) and deleted_at is null
        order by created_at asc`) as unknown as PostRow[];
}

export async function updatePost(db: Db, id: string, patch: {message?: string; props?: PostProps; edited?: boolean; fileIds?: string[]}): Promise<PostRow> {
    const t = now();
    const [row] = await db`
        update posts set
            message = coalesce(${patch.message ?? null}, message),
            props = case when ${patch.props !== undefined} then ${db.json((patch.props ?? {}) as never)} else props end,
            file_ids = coalesce(${patch.fileIds ?? null}, file_ids),
            edited_at = case when ${patch.edited ?? false} then ${t}::bigint else edited_at end,
            updated_at = ${t}
        where id = ${id}
        returning ${db.unsafe(COLS)}`;
    return row as unknown as PostRow;
}

// Merge keys into a post's props without overwriting others (safe for concurrent writers).
export async function mergePostProps(db: Db, id: string, props: PostProps): Promise<PostRow> {
    const [row] = await db`
        update posts set props = props || ${db.json(props as never)}, updated_at = ${now()}
        where id = ${id}
        returning ${db.unsafe(COLS)}`;
    return row as unknown as PostRow;
}

export async function softDeletePost(db: Db, id: string): Promise<void> {
    const t = now();
    const [row] = await db`update posts set deleted_at = ${t}, updated_at = ${t} where id = ${id} and deleted_at is null returning root_id`;
    if (row?.rootId) {
        await db`update posts set reply_count = greatest(reply_count - 1, 0) where id = ${row.rootId}`;
    }
}

export async function searchPosts(db: Db, workspaceId: string, userId: string, query: string, limit = 30): Promise<PostRow[]> {
    const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8).map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean);
    if (!terms.length) {
        return [];
    }
    const tsquery = terms.map((t) => `${t}:*`).join(' & ');
    const like = `%${query.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return (await db`
        select ${db.unsafe(COLS.split(', ').map((c) => `p.${c}`).join(', '))} from posts p
        join channel_members m on m.channel_id = p.channel_id and m.user_id = ${userId}
        where p.workspace_id = ${workspaceId} and p.deleted_at is null
          and (p.search @@ to_tsquery('simple', ${tsquery}) or p.message ilike ${like})
        order by p.created_at desc limit ${limit}`) as unknown as PostRow[];
}

// ------------------------------------------------------------ reactions

export async function addReaction(db: Db, postId: string, userId: string, emoji: string): Promise<void> {
    await db`insert into reactions (post_id, user_id, emoji, created_at) values (${postId}, ${userId}, ${emoji}, ${now()}) on conflict do nothing`;
}

export async function removeReaction(db: Db, postId: string, userId: string, emoji: string): Promise<void> {
    await db`delete from reactions where post_id = ${postId} and user_id = ${userId} and emoji = ${emoji}`;
}

export async function reactionsFor(db: Db, postIds: string[]): Promise<Map<string, {emoji: string; userIds: string[]}[]>> {
    const out = new Map<string, {emoji: string; userIds: string[]}[]>();
    if (!postIds.length) {
        return out;
    }
    const rows = await db`
        select post_id, emoji, array_agg(user_id order by created_at) as user_ids, min(created_at) as first
        from reactions where post_id = any(${postIds}) group by post_id, emoji order by first`;
    for (const r of rows) {
        const list = out.get(r.postId as string) ?? [];
        list.push({emoji: r.emoji as string, userIds: r.userIds as string[]});
        out.set(r.postId as string, list);
    }
    return out;
}
