// Publishing helpers: who should hear about what.

import type {Db} from '../db/index.js';
import type {Post, ServerEvent} from '../shared/types.js';
import {listChannelMemberIds} from '../store/channels.js';
import {listWorkspaceMembers} from '../store/workspaces.js';

import type {Ctx} from './context.js';
import {toPost} from './serialize.js';

export async function toChannel(ctx: Ctx, db: Db, channelId: string, event: ServerEvent, opts: {droppable?: boolean; exceptConnectionId?: string; exceptUserIds?: string[]} = {}): Promise<void> {
    let ids = await listChannelMemberIds(db, channelId);
    if (opts.exceptUserIds?.length) {
        ids = ids.filter((id) => !opts.exceptUserIds!.includes(id));
    }
    ctx.hub.publish(ids, event, opts);
}

export async function toWorkspace(ctx: Ctx, db: Db, workspaceId: string, event: ServerEvent): Promise<void> {
    const members = await listWorkspaceMembers(db, workspaceId);
    ctx.hub.publish(members.map((m) => m.userId), event);
}

export function toUsers(ctx: Ctx, userIds: string[], event: ServerEvent): void {
    ctx.hub.publish(userIds, event);
}

// Re-send a post that changed (edits, decision cards, plan cards, finished streams).
export async function postEdited(ctx: Ctx, db: Db, row: Parameters<typeof toPost>[1]): Promise<Post> {
    const post = await toPost(db, row);
    await toChannel(ctx, db, row.channelId, {event: 'post_edited', data: {post}});
    return post;
}
