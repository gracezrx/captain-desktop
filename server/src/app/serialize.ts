// Turning stored rows into API objects, in batches (one query per kind, not per post).

import {config} from '../config.js';
import type {Db} from '../db/index.js';
import type {FileInfo, Post} from '../shared/types.js';
import {type FileRow, getFiles} from '../store/files.js';
import {type PostRow, reactionsFor} from '../store/posts.js';
import {sign} from '../util/crypto.js';

export function fileInfo(f: FileRow): FileInfo {
    // Links expire, rounded to the hour so the same file keeps the same URL
    // (and stays cached) for a while.
    const hour = 3_600_000;
    const exp = Math.ceil((Date.now() + config.files.linkMinutes * 60_000) / hour) * hour;
    return {
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
        width: f.width,
        height: f.height,
        url: `/api/v1/files/${f.id}/content?exp=${exp}&sig=${sign(f.id, exp)}`,
    };
}

export async function toPosts(db: Db, rows: PostRow[]): Promise<Post[]> {
    const fileIds = [...new Set(rows.flatMap((r) => r.fileIds ?? []))];
    const [files, reactions] = await Promise.all([getFiles(db, fileIds), reactionsFor(db, rows.map((r) => r.id))]);
    const byId = new Map(files.map((f) => [f.id, fileInfo(f)]));
    return rows.map((r) => ({
        id: r.id,
        channelId: r.channelId,
        workspaceId: r.workspaceId,
        userId: r.userId,
        rootId: r.rootId,
        type: r.type,
        message: r.deletedAt ? '' : r.message,
        props: r.deletedAt ? {} : r.props ?? {},
        files: r.deletedAt ? [] : (r.fileIds ?? []).map((id) => byId.get(id)).filter((f): f is FileInfo => Boolean(f)),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        editedAt: r.editedAt,
        deletedAt: r.deletedAt,
        replyCount: r.replyCount,
        lastReplyAt: r.lastReplyAt,
        pendingId: r.pendingId,
        reactions: reactions.get(r.id) ?? [],
    }));
}

export async function toPost(db: Db, row: PostRow): Promise<Post> {
    return (await toPosts(db, [row]))[0];
}
