// Messages. createPost follows Mattermost's path: validate, run the
// before-save hooks, store, update unread and mention counters, deliver over
// WebSocket, then run the after-save hooks (where agents pick up work).

import {z} from 'zod';

import {tx, type Db} from '../db/index.js';
import type {Post, PostProps, PostType} from '../shared/types.js';
import {getAgentsByUserIds} from '../store/agents.js';
import {audit} from '../store/audit.js';
import {type ChannelRow, getChannel, listChannelMemberIds, recordPost} from '../store/channels.js';
import {attachFiles, getFiles} from '../store/files.js';
import {
    addReaction, getPost, insertPost, listChannelPosts, listThread, type PostRow, reactionsFor, removeReaction, searchPosts,
    softDeletePost, updatePost,
} from '../store/posts.js';
import {getUser, type UserRow} from '../store/users.js';
import {getMemberRole} from '../store/workspaces.js';
import {badRequest, forbidden, notFound} from '../util/errors.js';

import type {Ctx} from './context.js';
import {postEdited, toChannel as publishToChannel} from './events.js';
import {atLeast, requireChannelMember, requireWorkspaceRole} from './permissions.js';
import {toPost, toPosts} from './serialize.js';

export const MAX_MESSAGE = 16_000;

const postInput = z.object({
    message: z.string().max(MAX_MESSAGE, 'That message is too long.').default(''),
    rootId: z.string().nullable().optional(),
    fileIds: z.array(z.string()).max(10).default([]),
    pendingId: z.string().max(80).nullable().optional(),
});

// Who a message mentions: @handles of agents and people in the workspace,
// plus everyone in the channel for @channel, @all and @here.
export async function resolveMentions(db: Db, channel: ChannelRow, message: string, authorId: string): Promise<string[]> {
    const handles = [...new Set([...message.matchAll(/(?:^|[^\w@.])@([a-z0-9][a-z0-9._-]{0,40})/gi)].map((m) => m[1].toLowerCase().replace(/[._-]+$/, '')))];
    if (!handles.length) {
        return [];
    }
    const members = await listChannelMemberIds(db, channel.id);
    if (handles.some((h) => h === 'channel' || h === 'all' || h === 'here')) {
        return members.filter((id) => id !== authorId);
    }
    const rows = await db`
        select u.id from users u
        join workspace_members m on m.user_id = u.id and m.workspace_id = ${channel.workspaceId}
        left join agents a on a.user_id = u.id
        where u.deleted_at is null and (lower(u.username) = any(${handles}) or lower(a.handle) = any(${handles}))`;
    return rows.map((r) => r.id as string).filter((id) => id !== authorId);
}

type CreateInput = {message: string; rootId?: string | null; fileIds?: string[]; pendingId?: string | null; type?: PostType; props?: PostProps};

// The one path every message takes, from people and agents alike.
export async function savePost(ctx: Ctx, author: UserRow, channel: ChannelRow, input: CreateInput, opts: {skipHooks?: boolean} = {}): Promise<Post> {
    let message = input.message ?? '';
    let props: PostProps = input.props ?? {};
    const rootId = input.rootId ?? null;

    if (!opts.skipHooks) {
        const r = await ctx.hooks.runBefore({message, props, channel, author, rootId});
        if ('reject' in r) {
            throw badRequest(r.reject, 'rejected');
        }
        message = r.message;
        props = r.props;
    }

    const fileIds = input.fileIds ?? [];
    if (fileIds.length) {
        const files = await getFiles(ctx.sql, fileIds);
        if (files.length !== fileIds.length || files.some((f) => f.workspaceId !== channel.workspaceId || (f.userId !== author.id && !author.isBot) || f.postId)) {
            throw badRequest('One of the attachments can\'t be used here. Upload it again.');
        }
    }
    if (!message.trim() && !fileIds.length && !input.type && !props.streaming) {
        throw badRequest('Write a message or attach a file.');
    }

    const mentions = await resolveMentions(ctx.sql, channel, message, author.id);
    const row = await tx(ctx.sql, async (t) => {
        if (rootId) {
            const root = await getPost(t, rootId);
            if (!root || root.channelId !== channel.id || root.deletedAt) {
                throw badRequest('The message you\'re replying to is gone.');
            }
            if (root.rootId) {
                throw badRequest('Reply to the thread\'s first message.');
            }
        }
        const p = await insertPost(t, {channelId: channel.id, workspaceId: channel.workspaceId, userId: author.id, rootId, type: input.type ?? '', message, props, fileIds, pendingId: input.pendingId ?? null});
        await attachFiles(t, fileIds, p.id);
        // In a DM every message counts as a mention for the other person.
        const counted = channel.type === 'D' || channel.type === 'G' ? (await listChannelMemberIds(t, channel.id)).filter((id) => id !== author.id) : mentions;
        await recordPost(t, channel.id, author.id, p.createdAt, counted);
        return p;
    });

    const post = await toPost(ctx.sql, row);
    await publishToChannel(ctx, ctx.sql, channel.id, {event: 'posted', data: {post, mentions, channelType: channel.type}});
    if (!opts.skipHooks) {
        ctx.hooks.runAfter({post: row, channel, author, mentions});
    }
    return post;
}

export async function create(ctx: Ctx, user: UserRow, channelId: string, input: unknown): Promise<Post> {
    const data = postInput.parse(input);
    const {channel} = await requireChannelMember(ctx.sql, channelId, user.id);
    return savePost(ctx, user, channel, {message: data.message, rootId: data.rootId ?? null, fileIds: data.fileIds, pendingId: data.pendingId ?? null});
}

export async function list(ctx: Ctx, user: UserRow, channelId: string, opts: {before?: number; limit?: number}): Promise<Post[]> {
    await requireChannelMember(ctx.sql, channelId, user.id);
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
    const rows = await listChannelPosts(ctx.sql, channelId, {before: opts.before, limit});
    return toPosts(ctx.sql, rows);
}

export async function thread(ctx: Ctx, user: UserRow, postId: string): Promise<Post[]> {
    const post = await getPost(ctx.sql, postId);
    if (!post) {
        throw notFound('Message');
    }
    await requireChannelMember(ctx.sql, post.channelId, user.id);
    return toPosts(ctx.sql, await listThread(ctx.sql, post.rootId ?? post.id));
}

export async function getOne(ctx: Ctx, user: UserRow, postId: string): Promise<Post> {
    const post = await getPost(ctx.sql, postId);
    if (!post) {
        throw notFound('Message');
    }
    await requireChannelMember(ctx.sql, post.channelId, user.id);
    return toPost(ctx.sql, post);
}

async function editable(ctx: Ctx, user: UserRow, postId: string): Promise<PostRow> {
    const post = await getPost(ctx.sql, postId);
    if (!post || post.deletedAt) {
        throw notFound('Message');
    }
    await requireChannelMember(ctx.sql, post.channelId, user.id);
    if (post.userId !== user.id) {
        const role = await getMemberRole(ctx.sql, post.workspaceId, user.id);
        if (!role || !atLeast(role, 'admin')) {
            throw forbidden('You can only change your own messages.');
        }
    }
    return post;
}

export async function edit(ctx: Ctx, user: UserRow, postId: string, message: string): Promise<Post> {
    const post = await editable(ctx, user, postId);
    if (post.userId !== user.id) {
        throw forbidden('You can only edit your own messages.');
    }
    const text = z.string().trim().min(1, 'A message can\'t be empty.').max(MAX_MESSAGE).parse(message);
    const row = await updatePost(ctx.sql, postId, {message: text, edited: true});
    return postEdited(ctx, ctx.sql, row);
}

export async function remove(ctx: Ctx, user: UserRow, postId: string): Promise<void> {
    const post = await editable(ctx, user, postId);
    await softDeletePost(ctx.sql, postId);
    audit(ctx.sql, {workspaceId: post.workspaceId, userId: user.id, action: 'post_deleted', target: postId});
    await publishToChannel(ctx, ctx.sql, post.channelId, {event: 'post_deleted', data: {postId, channelId: post.channelId}});
}

export async function react(ctx: Ctx, user: UserRow, postId: string, emoji: string, on: boolean): Promise<void> {
    const e = z.string().min(1).max(32).parse(emoji);
    const post = await getPost(ctx.sql, postId);
    if (!post || post.deletedAt) {
        throw notFound('Message');
    }
    await requireChannelMember(ctx.sql, post.channelId, user.id);
    await (on ? addReaction(ctx.sql, postId, user.id, e) : removeReaction(ctx.sql, postId, user.id, e));
    const reactions = (await reactionsFor(ctx.sql, [postId])).get(postId) ?? [];
    await publishToChannel(ctx, ctx.sql, post.channelId, {event: 'reaction_changed', data: {postId, channelId: post.channelId, reactions}});
}

export async function search(ctx: Ctx, user: UserRow, workspaceId: string, q: string): Promise<Post[]> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    if (!q.trim()) {
        return [];
    }
    return toPosts(ctx.sql, await searchPosts(ctx.sql, workspaceId, user.id, q.slice(0, 200)));
}

// A button on a message (Approve / Reject on decision cards).
export async function action(ctx: Ctx, user: UserRow, postId: string, actionId: string, body: unknown = {}): Promise<Post> {
    // "Change it": turn the draft down with what should change.
    const raw = (body as {note?: unknown} | null)?.note;
    const note = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : null;
    const post = await getPost(ctx.sql, postId);
    if (!post || post.deletedAt) {
        throw notFound('Message');
    }
    await requireChannelMember(ctx.sql, post.channelId, user.id);
    const role = await getMemberRole(ctx.sql, post.workspaceId, user.id);
    if (role === 'guest') {
        throw forbidden('Guests can\'t approve agent actions.');
    }
    const handler = ctx.hooks.actionHandler(post.type);
    if (!handler) {
        throw badRequest('This message has no actions.');
    }
    await handler(ctx.sql, {post, action: actionId, user, note});
    return toPost(ctx.sql, (await getPost(ctx.sql, postId))!);
}

// Is this user an agent? (agent messages skip the agent triggers)
export async function agentIdsFor(db: Db, userIds: string[]): Promise<Map<string, string>> {
    return new Map((await getAgentsByUserIds(db, userIds)).map((a) => [a.userId, a.id]));
}

export async function channelOf(ctx: Ctx, channelId: string): Promise<ChannelRow> {
    const c = await getChannel(ctx.sql, channelId);
    if (!c) {
        throw notFound('Channel');
    }
    return c;
}

export async function author(ctx: Ctx, userId: string): Promise<UserRow> {
    const u = await getUser(ctx.sql, userId);
    if (!u) {
        throw notFound('User');
    }
    return u;
}
