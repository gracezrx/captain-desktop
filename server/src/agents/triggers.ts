// When does an agent pick up a message? (afterPostSave, like a Mattermost bot)
// - a direct message to an agent: that agent answers
// - an @mention of an agent's handle: that agent answers (up to three per message);
//   mentioning an agent in a channel it isn't in brings it in
// - a reply in a thread an agent was working in, with no mention: that agent continues
// @captain answers directly or plans the work across the team.
// Agents never trigger on other agents' messages, so they can't loop.

import type {Ctx} from '../app/context.js';
import {toChannel as publishToChannel} from '../app/events.js';
import type {SavedPost} from '../app/hooks.js';
import {tx} from '../db/index.js';
import {type AgentRow, getAgent, getAgentsByUserIds, listAgents} from '../store/agents.js';
import {addChannelMember, listChannelMemberIds} from '../store/channels.js';
import {createRun} from '../store/runs.js';
import {log} from '../util/log.js';

const MAX_AGENTS_PER_MESSAGE = 3;

export function mentionedHandles(message: string): string[] {
    return [...new Set([...message.matchAll(/(?:^|[^\w@.])@([a-z0-9][a-z0-9._-]{0,40})/gi)].map((m) => m[1].toLowerCase().replace(/[._-]+$/, '')))];
}

async function agentsToRun(ctx: Ctx, saved: SavedPost): Promise<AgentRow[]> {
    const {post, channel} = saved;
    if (channel.type === 'D') {
        const others = (await listChannelMemberIds(ctx.sql, channel.id)).filter((id) => id !== post.userId);
        return (await getAgentsByUserIds(ctx.sql, others)).filter((a) => a.enabled);
    }
    const handles = mentionedHandles(post.message);
    if (handles.length) {
        const agents = (await listAgents(ctx.sql, channel.workspaceId)).filter((a) => a.enabled && handles.includes(a.handle.toLowerCase()));
        if (agents.length) {
            // Captain first, so a plan can include the others' work.
            return agents.sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator)).slice(0, MAX_AGENTS_PER_MESSAGE);
        }
        if (handles.some((h) => !['channel', 'all', 'here'].includes(h))) {
            return []; // mentioned people, not agents
        }
    }
    if (post.rootId) {
        const [last] = await ctx.sql`
            select agent_id from runs where channel_id = ${channel.id} and (root_post_id = ${post.rootId} or card_post_id = ${post.rootId})
            order by created_at desc limit 1`;
        if (last) {
            const agent = await getAgent(ctx.sql, last.agentId as string);
            return agent?.enabled ? [agent] : [];
        }
    }
    return [];
}

export function registerTriggers(ctx: Ctx): void {
    ctx.hooks.afterPostSave(async (saved) => {
        const {post, channel, author} = saved;
        if (author.isBot || post.type !== '' || channel.deletedAt) {
            return;
        }
        const agents = await agentsToRun(ctx, saved);
        if (!agents.length) {
            return;
        }
        // In a DM, answer in the conversation; elsewhere, in the message's thread.
        const replyRoot = channel.type === 'D' && !post.rootId ? null : post.rootId ?? post.id;
        const members = new Set(await listChannelMemberIds(ctx.sql, channel.id));
        for (const agent of agents) {
            const added = await tx(ctx.sql, async (t) => {
                const joined = !members.has(agent.userId) && (await addChannelMember(t, channel.id, agent.userId));
                const run = await createRun(t, {
                    workspaceId: channel.workspaceId, channelId: channel.id, rootPostId: replyRoot, triggerPostId: post.id,
                    requestedBy: author.id, agentId: agent.id, kind: 'single', goal: post.message.replace(/^(@[a-z0-9._-]+[\s,:]*)+/i, '').slice(0, 300),
                });
                await ctx.jobs.enqueue(t, 'run.start', {runId: run.id});
                return joined;
            });
            if (added) {
                await publishToChannel(ctx, ctx.sql, channel.id, {event: 'channel_member_added', data: {channelId: channel.id, userId: agent.userId}});
            }
            log.debug({agent: agent.handle, post: post.id}, 'agent run queued');
        }
    });
}
