// Reading the workspace. Agents see only what the person who asked can see:
// searches and channel reads run with the requester's channel memberships.

import {getChannelByName, getChannelMember, listMyChannels} from '../../store/channels.js';
import {listChannelPosts, searchPosts} from '../../store/posts.js';
import {getUsers} from '../../store/users.js';

import {str, type Tool} from './types.js';

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
        const rows = await searchPosts(tc.ctx.sql, tc.channel.workspaceId, tc.requester.id, query, 15);
        if (!rows.length) {
            return {content: `No messages match "${query}".`};
        }
        const users = new Map((await getUsers(tc.ctx.sql, [...new Set(rows.map((r) => r.userId))])).map((u) => [u.id, u.displayName]));
        const channels = new Map((await listMyChannels(tc.ctx.sql, tc.channel.workspaceId, tc.requester.id)).map((c) => [c.channel.id, c.channel]));
        return {
            content: rows.map((r) => {
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
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
        const rows = (await listChannelPosts(tc.ctx.sql, channel.id, {limit})).reverse();
        const users = new Map((await getUsers(tc.ctx.sql, [...new Set(rows.map((r) => r.userId))])).map((u) => [u.id, u.displayName]));
        if (!rows.length) {
            return {content: `#${name} has no messages yet.`};
        }
        return {content: `#${name}${channel.purpose ? ` (${channel.purpose})` : ''}:\n${rows.map((r) => `[${when(r.createdAt)}] ${users.get(r.userId) ?? 'Someone'}: ${r.message.slice(0, 600)}`).join('\n')}`};
    },
};
