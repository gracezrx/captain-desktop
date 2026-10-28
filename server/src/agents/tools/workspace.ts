// Reading the workspace. Two rules keep private messages private:
// - agents see only what the person who asked can see (their memberships)
// - an answer is posted where the question was asked, so a source is used only
//   if everyone in that conversation could already read it: every person here
//   is a member of the source, or the source is public and nobody here is a guest

import type {Db} from '../../db/index.js';
import {getChannelByName, getChannelMember, listMyChannels} from '../../store/channels.js';
import {listChannelPosts, searchPosts} from '../../store/posts.js';
import {getUsers} from '../../store/users.js';

import {str, type Tool} from './types.js';

export async function shareableIn(db: Db, destinationId: string, sourceIds: string[]): Promise<Set<string>> {
    if (!sourceIds.length) {
        return new Set();
    }
    const rows = await db`
        select c.id from channels c
        where c.id = any(${sourceIds}) and (
            c.id = ${destinationId}
            or not exists (
                select 1 from channel_members dm join users u on u.id = dm.user_id and not u.is_bot
                where dm.channel_id = ${destinationId}
                  and not exists (select 1 from channel_members sm where sm.channel_id = c.id and sm.user_id = dm.user_id))
            or (c.type = 'O' and not exists (
                select 1 from channel_members dm
                join users u on u.id = dm.user_id and not u.is_bot
                join workspace_members wm on wm.user_id = dm.user_id and wm.workspace_id = c.workspace_id
                where dm.channel_id = ${destinationId} and wm.role = 'guest'))
        )`;
    return new Set(rows.map((r) => r.id as string));
}

function when(ms: number): string {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export const searchWorkspace: Tool = {
    name: 'search_workspace',
    description: 'Search messages across the channels the requester belongs to. Use it to find earlier decisions, numbers, links or context.',
    parameters: {type: 'object', properties: {query: {type: 'string', description: 'Words to look for'}}, required: ['query']},
    external: false,
    available: () => true,
    async run(tc, args) {
        const query = str(args.query, 200);
        const found = await searchPosts(tc.ctx.sql, tc.channel.workspaceId, tc.requester.id, query, 40);
        const ok = await shareableIn(tc.ctx.sql, tc.channel.id, [...new Set(found.map((r) => r.channelId))]);
        const rows = found.filter((r) => ok.has(r.channelId)).slice(0, 15);
        const hidden = found.length - found.filter((r) => ok.has(r.channelId)).length;
        if (!rows.length) {
            return {content: hidden ? `Matches exist only in conversations some people here can't see, so they're left out. Ask in a direct message to search those.` : `No messages match "${query}".`};
        }
        const users = new Map((await getUsers(tc.ctx.sql, [...new Set(rows.map((r) => r.userId))])).map((u) => [u.id, u.displayName]));
        const channels = new Map((await listMyChannels(tc.ctx.sql, tc.channel.workspaceId, tc.requester.id)).map((c) => [c.channel.id, c.channel]));
        return {
            content: (hidden ? `(${hidden} more matches are in conversations some people here can't see, so they're left out.)\n` : '') + rows.map((r) => {
                const c = channels.get(r.channelId);
                const where = c ? (c.type === 'D' || c.type === 'G' ? 'a direct message' : `#${c.name}`) : 'a channel';
                return `[${when(r.createdAt)}] ${users.get(r.userId) ?? 'Someone'} in ${where}: ${r.message.slice(0, 500)}`;
            }).join('\n'),
        };
    },
};

export const readChannel: Tool = {
    name: 'read_channel',
    description: 'Read the latest messages of a channel by name (without the #). Only channels the requester belongs to.',
    parameters: {type: 'object', properties: {channel: {type: 'string'}, limit: {type: 'number', description: 'How many messages, up to 50'}}, required: ['channel']},
    external: false,
    available: () => true,
    async run(tc, args) {
        const name = str(args.channel, 80).replace(/^#/, '').trim().toLowerCase();
        const channel = await getChannelByName(tc.ctx.sql, tc.channel.workspaceId, name);
        if (!channel || !(await getChannelMember(tc.ctx.sql, channel.id, tc.requester.id))) {
            return {content: `There's no channel #${name} that the requester can read.`};
        }
        if (!(await shareableIn(tc.ctx.sql, tc.channel.id, [channel.id])).has(channel.id)) {
            return {content: `Some people in this conversation can't see #${name}, so it can't be quoted here. Ask in a direct message instead.`};
        }
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
        const rows = (await listChannelPosts(tc.ctx.sql, channel.id, {limit})).reverse();
        const users = new Map((await getUsers(tc.ctx.sql, [...new Set(rows.map((r) => r.userId))])).map((u) => [u.id, u.displayName]));
        if (!rows.length) {
            return {content: `#${name} has no messages yet.`};
        }
        return {content: `#${name}${channel.purpose ? ` (${channel.purpose})` : ''}:\n${rows.map((r) => `[${when(r.createdAt)}] ${users.get(r.userId) ?? 'Someone'}: ${r.message.slice(0, 600)}`).join('\n')}`};
    },
};
