// Channels: open (O), private (P), direct messages (D) and group messages (G).

import {z} from 'zod';

import {tx} from '../db/index.js';
import type {Channel, ChannelMember} from '../shared/types.js';
import {getAgentByUserId} from '../store/agents.js';
import {audit} from '../store/audit.js';
import {
    addChannelMember, archiveChannel, createChannel, dmName, getChannel, getChannelByName, getChannelMember, listChannelMembers,
    listMyChannels, listPublicChannels, markViewed, memberIdsForChannels, removeChannelMember, toChannel, updateChannel,
} from '../store/channels.js';
import {getUsers, type UserRow} from '../store/users.js';
import {getMemberRole} from '../store/workspaces.js';
import {badRequest, conflict, forbidden, notFound} from '../util/errors.js';

import type {Ctx} from './context.js';
import {toChannel as publishToChannel, toUsers} from './events.js';
import {atLeast, requireChannelMember, requireWorkspaceRole} from './permissions.js';

const channelInput = z.object({
    displayName: z.string().trim().min(1, 'Name the channel.').max(64),
    purpose: z.string().trim().max(250).optional(),
    type: z.enum(['O', 'P']).default('O'),
    memberIds: z.array(z.string()).max(200).optional(),
});

function slugify(name: string): string {
    return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'channel';
}

export async function myChannels(ctx: Ctx, user: UserRow, workspaceId: string): Promise<{channels: Channel[]; members: ChannelMember[]}> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    const rows = await listMyChannels(ctx.sql, workspaceId, user.id);
    const dmIds = rows.filter((r) => r.channel.type === 'D' || r.channel.type === 'G').map((r) => r.channel.id);
    const memberMap = await memberIdsForChannels(ctx.sql, dmIds);
    return {
        channels: rows.map((r) => toChannel(r.channel, memberMap.get(r.channel.id))),
        members: rows.map((r) => ({channelId: r.member.channelId, userId: r.member.userId, role: r.member.role, lastViewedAt: r.member.lastViewedAt, msgCount: r.member.msgCount, mentionCount: r.member.mentionCount})),
    };
}

export async function browse(ctx: Ctx, user: UserRow, workspaceId: string): Promise<Channel[]> {
    const role = await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    if (role === 'guest') {
        return [];
    }
    return (await listPublicChannels(ctx.sql, workspaceId)).map((c) => toChannel(c));
}

export async function create(ctx: Ctx, user: UserRow, workspaceId: string, input: unknown): Promise<Channel> {
    const role = await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'member');
    const data = channelInput.parse(input);
    let name = slugify(data.displayName);
    for (let i = 2; await getChannelByName(ctx.sql, workspaceId, name); i++) {
        name = `${slugify(data.displayName)}-${i}`;
    }
    const memberIds: string[] = [];
    const channel = await tx(ctx.sql, async (t) => {
        const c = await createChannel(t, {workspaceId, type: data.type, name, displayName: data.displayName, purpose: data.purpose, createdBy: user.id});
        for (const id of new Set([user.id, ...(data.memberIds ?? [])])) {
            if (id === user.id || (await getMemberRole(t, workspaceId, id))) {
                await addChannelMember(t, c.id, id, id === user.id ? 'admin' : 'member');
                memberIds.push(id);
            }
        }
        return c;
    });
    audit(ctx.sql, {workspaceId, userId: user.id, action: 'channel_created', target: channel.id, meta: {type: data.type, role}});
    const dto = toChannel(channel);
    toUsers(ctx, memberIds, {event: 'channel_created', data: {channel: dto}});
    return dto;
}

export async function update(ctx: Ctx, user: UserRow, channelId: string, input: {displayName?: string; purpose?: string; captainJoinsIn?: boolean}): Promise<Channel> {
    const {channel, member} = await requireChannelMember(ctx.sql, channelId, user.id);
    const role = await requireWorkspaceRole(ctx.sql, channel.workspaceId, user.id, 'member');
    const renaming = input.displayName !== undefined || input.purpose !== undefined;
    if (channel.type === 'D' && input.captainJoinsIn !== undefined) {
        throw badRequest('Captain always answers in a direct message with it.');
    }
    if (renaming && (channel.type === 'D' || channel.type === 'G')) {
        throw badRequest('Direct messages can\'t be renamed.');
    }
    // Anyone in the chat can say whether Captain joins in; renaming a private one needs an admin.
    if (renaming && member.role !== 'admin' && !atLeast(role, 'admin') && channel.type === 'P') {
        throw forbidden();
    }
    const updated = await updateChannel(ctx.sql, channelId, {
        displayName: input.displayName !== undefined ? z.string().trim().min(1).max(64).parse(input.displayName) : undefined,
        purpose: input.purpose !== undefined ? z.string().trim().max(250).parse(input.purpose) : undefined,
        captainJoinsIn: input.captainJoinsIn,
    });
    const dto = toChannel(updated);
    await publishToChannel(ctx, ctx.sql, channelId, {event: 'channel_updated', data: {channel: dto}});
    return dto;
}

export async function archive(ctx: Ctx, user: UserRow, channelId: string): Promise<void> {
    const channel = await getChannel(ctx.sql, channelId);
    if (!channel) {
        throw notFound('Channel');
    }
    await requireWorkspaceRole(ctx.sql, channel.workspaceId, user.id, 'admin');
    if (channel.name === 'general') {
        throw badRequest('General can\'t be archived.');
    }
    await archiveChannel(ctx.sql, channelId);
    audit(ctx.sql, {workspaceId: channel.workspaceId, userId: user.id, action: 'channel_archived', target: channelId});
}

export async function join(ctx: Ctx, user: UserRow, channelId: string): Promise<Channel> {
    const channel = await getChannel(ctx.sql, channelId);
    if (!channel) {
        throw notFound('Channel');
    }
    const role = await requireWorkspaceRole(ctx.sql, channel.workspaceId, user.id);
    if (channel.type !== 'O' || role === 'guest') {
        throw notFound('Channel');
    }
    if (await addChannelMember(ctx.sql, channelId, user.id)) {
        await publishToChannel(ctx, ctx.sql, channelId, {event: 'channel_member_added', data: {channelId, userId: user.id}});
    }
    return toChannel(channel);
}

export async function leave(ctx: Ctx, user: UserRow, channelId: string): Promise<void> {
    const {channel} = await requireChannelMember(ctx.sql, channelId, user.id);
    if (channel.type === 'D') {
        throw badRequest('You can\'t leave a direct message.');
    }
    await removeChannelMember(ctx.sql, channelId, user.id);
    await publishToChannel(ctx, ctx.sql, channelId, {event: 'channel_member_removed', data: {channelId, userId: user.id}});
    toUsers(ctx, [user.id], {event: 'channel_member_removed', data: {channelId, userId: user.id}});
}

export async function addMembers(ctx: Ctx, user: UserRow, channelId: string, userIds: string[]): Promise<void> {
    const {channel} = await requireChannelMember(ctx.sql, channelId, user.id);
    await requireWorkspaceRole(ctx.sql, channel.workspaceId, user.id, 'member');
    if (channel.type === 'D') {
        throw badRequest('Start a group message to talk with more people.');
    }
    for (const id of [...new Set(userIds)].slice(0, 100)) {
        if (!(await getMemberRole(ctx.sql, channel.workspaceId, id))) {
            continue;
        }
        if (await addChannelMember(ctx.sql, channelId, id)) {
            await publishToChannel(ctx, ctx.sql, channelId, {event: 'channel_member_added', data: {channelId, userId: id}});
            toUsers(ctx, [id], {event: 'channel_created', data: {channel: toChannel(channel)}});
        }
    }
}

export async function removeMember(ctx: Ctx, user: UserRow, channelId: string, userId: string): Promise<void> {
    const {channel, member} = await requireChannelMember(ctx.sql, channelId, user.id);
    const role = await requireWorkspaceRole(ctx.sql, channel.workspaceId, user.id, 'member');
    if (channel.type === 'D' || channel.name === 'general') {
        throw badRequest('Members can\'t be removed from this channel.');
    }
    if (member.role !== 'admin' && !atLeast(role, 'admin')) {
        throw forbidden();
    }
    if (await removeChannelMember(ctx.sql, channelId, userId)) {
        await publishToChannel(ctx, ctx.sql, channelId, {event: 'channel_member_removed', data: {channelId, userId}});
        toUsers(ctx, [userId], {event: 'channel_member_removed', data: {channelId, userId}});
    }
}

export async function channelMembers(ctx: Ctx, user: UserRow, channelId: string): Promise<ChannelMember[]> {
    await requireChannelMember(ctx.sql, channelId, user.id);
    return (await listChannelMembers(ctx.sql, channelId)).map((m) => ({channelId: m.channelId, userId: m.userId, role: m.role, lastViewedAt: m.lastViewedAt, msgCount: m.msgCount, mentionCount: m.mentionCount}));
}

// Find or create the direct message between you and someone (a person or an agent).
export async function directMessage(ctx: Ctx, user: UserRow, workspaceId: string, otherId: string): Promise<Channel> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    if (!(await getMemberRole(ctx.sql, workspaceId, otherId))) {
        throw notFound('Person');
    }
    const name = dmName(user.id, otherId);
    const existing = await getChannelByName(ctx.sql, workspaceId, name);
    if (existing) {
        return toChannel(existing, [...new Set([user.id, otherId])]);
    }
    const [other] = await getUsers(ctx.sql, [otherId]);
    if (!other) {
        throw notFound('Person');
    }
    if (other.isBot) {
        const agent = await getAgentByUserId(ctx.sql, otherId);
        if (!agent?.enabled) {
            throw badRequest('This agent is turned off.');
        }
    }
    try {
        const channel = await tx(ctx.sql, async (t) => {
            const c = await createChannel(t, {workspaceId, type: 'D', name, displayName: '', createdBy: user.id});
            await addChannelMember(t, c.id, user.id);
            if (otherId !== user.id) {
                await addChannelMember(t, c.id, otherId);
            }
            return c;
        });
        const dto = toChannel(channel, [...new Set([user.id, otherId])]);
        toUsers(ctx, [user.id, otherId], {event: 'channel_created', data: {channel: dto}});
        return dto;
    } catch (e) {
        if ((e as {code?: string}).code === '23505') {
            const again = await getChannelByName(ctx.sql, workspaceId, name);
            if (again) {
                return toChannel(again, [user.id, otherId]);
            }
        }
        throw e;
    }
}

export async function view(ctx: Ctx, user: UserRow, channelId: string): Promise<void> {
    const member = await getChannelMember(ctx.sql, channelId, user.id);
    if (!member) {
        throw notFound('Channel');
    }
    await markViewed(ctx.sql, channelId, user.id);
    // Your other windows and devices clear the badge too.
    toUsers(ctx, [user.id], {event: 'channel_viewed', data: {channelId}});
}

export async function getOne(ctx: Ctx, user: UserRow, channelId: string): Promise<Channel> {
    const {channel} = await requireChannelMember(ctx.sql, channelId, user.id);
    const memberIds = channel.type === 'D' || channel.type === 'G' ? (await memberIdsForChannels(ctx.sql, [channelId])).get(channelId) : undefined;
    return toChannel(channel, memberIds);
}

export async function assertUnique(ctx: Ctx, workspaceId: string, name: string): Promise<void> {
    if (await getChannelByName(ctx.sql, workspaceId, name)) {
        throw conflict('A channel with that name already exists.');
    }
}
