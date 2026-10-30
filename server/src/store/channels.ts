import type {Db} from '../db/index.js';
import type {Channel, ChannelMember, ChannelType} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type ChannelRow = {
    id: string;
    workspaceId: string;
    type: ChannelType;
    name: string;
    displayName: string;
    purpose: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    lastPostAt: number;
    totalMsgCount: number;
    captainJoinsIn: boolean;
};

export type ChannelMemberRow = ChannelMember & {joinedAt: number};

export function toChannel(r: ChannelRow, memberIds?: string[]): Channel {
    return {
        id: r.id,
        workspaceId: r.workspaceId,
        type: r.type,
        name: r.name,
        displayName: r.displayName,
        purpose: r.purpose,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        lastPostAt: r.lastPostAt,
        totalMsgCount: r.totalMsgCount,
        captainJoinsIn: r.captainJoinsIn ?? true,
        ...(memberIds ? {memberIds} : {}),
    };
}

export function dmName(a: string, b: string): string {
    return [a, b].sort().join('__');
}

export async function createChannel(db: Db, c: {workspaceId: string; type: ChannelType; name: string; displayName: string; purpose?: string; createdBy: string}): Promise<ChannelRow> {
    const t = now();
    const [row] = await db`
        insert into channels (id, workspace_id, type, name, display_name, purpose, created_by, created_at, updated_at)
        values (${newId()}, ${c.workspaceId}, ${c.type}, ${c.name}, ${c.displayName}, ${c.purpose ?? ''}, ${c.createdBy}, ${t}, ${t})
        returning *`;
    return row as unknown as ChannelRow;
}

export async function getChannel(db: Db, id: string): Promise<ChannelRow | null> {
    const [row] = await db`select * from channels where id = ${id} and deleted_at is null`;
    return (row as unknown as ChannelRow) ?? null;
}

export async function getChannelByName(db: Db, workspaceId: string, name: string): Promise<ChannelRow | null> {
    const [row] = await db`select * from channels where workspace_id = ${workspaceId} and name = ${name} and deleted_at is null`;
    return (row as unknown as ChannelRow) ?? null;
}

export async function updateChannel(db: Db, id: string, patch: {displayName?: string; purpose?: string; captainJoinsIn?: boolean}): Promise<ChannelRow> {
    const [row] = await db`
        update channels set
            display_name = coalesce(${patch.displayName ?? null}, display_name),
            purpose = coalesce(${patch.purpose ?? null}, purpose),
            captain_joins_in = coalesce(${patch.captainJoinsIn ?? null}, captain_joins_in),
            updated_at = ${now()}
        where id = ${id}
        returning *`;
    return row as unknown as ChannelRow;
}

export async function archiveChannel(db: Db, id: string): Promise<void> {
    await db`update channels set deleted_at = ${now()} where id = ${id}`;
}

// Channels a user belongs to in a workspace, with their membership row.
export async function listMyChannels(db: Db, workspaceId: string, userId: string): Promise<{channel: ChannelRow; member: ChannelMemberRow}[]> {
    const rows = await db`
        select c.*, m.role as m_role, m.joined_at as m_joined_at, m.last_viewed_at as m_last_viewed_at,
               m.msg_count as m_msg_count, m.mention_count as m_mention_count
        from channels c join channel_members m on m.channel_id = c.id
        where c.workspace_id = ${workspaceId} and m.user_id = ${userId} and c.deleted_at is null
        order by c.last_post_at desc`;
    return rows.map((r) => {
        const {mRole, mJoinedAt, mLastViewedAt, mMsgCount, mMentionCount, ...c} = r as Record<string, unknown>;
        return {
            channel: c as unknown as ChannelRow,
            member: {channelId: c.id as string, userId, role: mRole as 'admin' | 'member', joinedAt: mJoinedAt as number, lastViewedAt: mLastViewedAt as number, msgCount: mMsgCount as number, mentionCount: mMentionCount as number},
        };
    });
}

export async function listPublicChannels(db: Db, workspaceId: string): Promise<ChannelRow[]> {
    return (await db`select * from channels where workspace_id = ${workspaceId} and type = 'O' and deleted_at is null order by display_name`) as unknown as ChannelRow[];
}

export async function addChannelMember(db: Db, channelId: string, userId: string, role: 'admin' | 'member' = 'member'): Promise<boolean> {
    // New members start with everything already read.
    const r = await db`
        insert into channel_members (channel_id, user_id, role, joined_at, last_viewed_at, msg_count)
        select ${channelId}, ${userId}, ${role}, ${now()}, ${now()}, total_msg_count from channels where id = ${channelId}
        on conflict (channel_id, user_id) do nothing`;
    return r.count === 1;
}

export async function removeChannelMember(db: Db, channelId: string, userId: string): Promise<boolean> {
    const r = await db`delete from channel_members where channel_id = ${channelId} and user_id = ${userId}`;
    return r.count === 1;
}

export async function getChannelMember(db: Db, channelId: string, userId: string): Promise<ChannelMemberRow | null> {
    const [row] = await db`select * from channel_members where channel_id = ${channelId} and user_id = ${userId}`;
    return (row as unknown as ChannelMemberRow) ?? null;
}

export async function listChannelMemberIds(db: Db, channelId: string): Promise<string[]> {
    return (await db`select user_id from channel_members where channel_id = ${channelId}`).map((r) => r.userId as string);
}

export async function listChannelMembers(db: Db, channelId: string): Promise<ChannelMemberRow[]> {
    return (await db`select * from channel_members where channel_id = ${channelId} order by joined_at`) as unknown as ChannelMemberRow[];
}

export async function memberIdsForChannels(db: Db, channelIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!channelIds.length) {
        return out;
    }
    for (const r of await db`select channel_id, user_id from channel_members where channel_id = any(${channelIds})`) {
        const list = out.get(r.channelId as string) ?? [];
        list.push(r.userId as string);
        out.set(r.channelId as string, list);
    }
    return out;
}

// A new message: bump the channel's counters, keep the author's read state
// current, and add a mention for each mentioned member. Counters live on the
// membership row so unread badges never need to count posts.
export async function recordPost(db: Db, channelId: string, authorId: string, createdAt: number, mentionedIds: string[]): Promise<void> {
    await db`update channels set total_msg_count = total_msg_count + 1, last_post_at = greatest(last_post_at, ${createdAt}) where id = ${channelId}`;
    await db`update channel_members set msg_count = msg_count + 1, last_viewed_at = ${createdAt} where channel_id = ${channelId} and user_id = ${authorId}`;
    if (mentionedIds.length) {
        await db`update channel_members set mention_count = mention_count + 1 where channel_id = ${channelId} and user_id = any(${mentionedIds}) and user_id <> ${authorId}`;
    }
}

export async function markViewed(db: Db, channelId: string, userId: string): Promise<void> {
    await db`
        update channel_members m set msg_count = c.total_msg_count, mention_count = 0, last_viewed_at = ${now()}
        from channels c where c.id = m.channel_id and m.channel_id = ${channelId} and m.user_id = ${userId}`;
}
