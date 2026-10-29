// When does an agent pick up a message? (afterPostSave, like a Mattermost bot)
// - a direct message to an agent: that agent answers
// - an @mention of one agent's handle: that agent answers; mentioning an agent
//   in a channel it isn't in brings it in
// - @mentions of two or more agents: ONE run, with Captain coordinating just
//   the agents named. Captain splits the work between them, each does its part
//   in the thread (later parts see earlier ones), and Captain posts one answer.
//   This replaces each agent answering on its own, which duplicated the work
//   and sent several full conversations to the models at once.
// - a reply in a thread an agent was working in, with no mention: that agent
//   continues (Captain, with the same team, for a coordinated thread)
// @captain on its own answers directly or plans the work across the team.
// Agents never trigger on other agents' messages, so they can't loop.

import type {Ctx} from '../app/context.js';
import {toChannel as publishToChannel} from '../app/events.js';
import type {SavedPost} from '../app/hooks.js';
import {tx} from '../db/index.js';
import {type AgentRow, getAgent, getAgentsByUserIds, listAgents} from '../store/agents.js';
import {addChannelMember, listChannelMemberIds} from '../store/channels.js';
import {createRun} from '../store/runs.js';
import {log} from '../util/log.js';

const MAX_AGENTS_PER_MESSAGE = 6;

type Chosen = {agents: AgentRow[]; team: string[] | null};

export function mentionedHandles(message: string): string[] {
    return [...new Set([...message.matchAll(/(?:^|[^\w@.])@([a-z0-9][a-z0-9._-]{0,40})/gi)].map((m) => m[1].toLowerCase().replace(/[._-]+$/, '')))];
}

async function agentsToRun(ctx: Ctx, saved: SavedPost): Promise<Chosen> {
    const {post, channel} = saved;
    const none: Chosen = {agents: [], team: null};
    const handles = mentionedHandles(post.message);
    if (channel.type === 'D') {
        const others = (await listChannelMemberIds(ctx.sql, channel.id)).filter((id) => id !== post.userId);
        const dmAgents = (await getAgentsByUserIds(ctx.sql, others)).filter((a) => a.enabled);
        // In your DM with Captain, naming agents means Captain works with just them.
        const captain = dmAgents.length === 1 && dmAgents[0].isCoordinator ? dmAgents[0] : null;
        if (captain && handles.length) {
            const team = (await listAgents(ctx.sql, channel.workspaceId)).filter((a) => a.enabled && !a.isCoordinator && handles.includes(a.handle.toLowerCase())).slice(0, MAX_AGENTS_PER_MESSAGE);
            if (team.length) {
                return {agents: [captain, ...team], team: team.map((a) => a.id)};
            }
        }
        return {agents: dmAgents, team: null};
    }
    if (handles.length) {
        const all = await listAgents(ctx.sql, channel.workspaceId);
        const named = all.filter((a) => a.enabled && handles.includes(a.handle.toLowerCase())).slice(0, MAX_AGENTS_PER_MESSAGE);
        if (named.length === 1) {
            return {agents: named, team: null};
        }
        if (named.length > 1) {
            // Several agents named: Captain coordinates them.
            const captain = all.find((a) => a.isCoordinator && a.enabled);
            const team = named.filter((a) => !a.isCoordinator);
            if (captain && team.length) {
                return {agents: [captain, ...team], team: team.map((a) => a.id)};
            }
            // Captain is turned off: each named agent answers on its own.
            return {agents: named, team: null};
        }
        if (handles.some((h) => !['channel', 'all', 'here'].includes(h))) {
            return none; // mentioned people, not agents
        }
    }
    if (post.rootId) {
        const [last] = await ctx.sql`
            select agent_id, team from runs where channel_id = ${channel.id} and (root_post_id = ${post.rootId} or card_post_id = ${post.rootId})
            order by created_at desc limit 1`;
        if (last) {
            const agent = await getAgent(ctx.sql, last.agentId as string);
            return agent?.enabled ? {agents: [agent], team: (last.team as string[] | null) ?? null} : none;
        }
    }
    return none;
}

export function registerTriggers(ctx: Ctx): void {
    ctx.hooks.afterPostSave(async (saved) => {
        const {post, channel, author} = saved;
        if (author.isBot || post.type !== '' || channel.deletedAt) {
            return;
        }
        const {agents, team} = await agentsToRun(ctx, saved);
        if (!agents.length) {
            return;
        }
        // In a DM, answer in the conversation; elsewhere, in the message's thread.
        const replyRoot = channel.type === 'D' && !post.rootId ? null : post.rootId ?? post.id;
        const members = new Set(await listChannelMemberIds(ctx.sql, channel.id));
        // A coordinated team works in one run, led by Captain (agents[0]);
        // otherwise each agent (one, or a DM's) has its own.
        const leads = team ? agents.slice(0, 1) : agents;
        const joined = await tx(ctx.sql, async (t) => {
            const added: string[] = [];
            for (const agent of agents) {
                if (channel.type !== 'D' && !members.has(agent.userId) && (await addChannelMember(t, channel.id, agent.userId))) {
                    added.push(agent.userId);
                }
            }
            for (const agent of leads) {
                const run = await createRun(t, {
                    workspaceId: channel.workspaceId, channelId: channel.id, rootPostId: replyRoot, triggerPostId: post.id, team,
                    requestedBy: author.id, agentId: agent.id, kind: 'single', goal: post.message.replace(/^(@[a-z0-9._-]+[\s,:]*)+/i, '').slice(0, 300),
                });
                await ctx.jobs.enqueue(t, 'run.start', {runId: run.id});
            }
            return added;
        });
        for (const userId of joined) {
            await publishToChannel(ctx, ctx.sql, channel.id, {event: 'channel_member_added', data: {channelId: channel.id, userId}});
        }
        log.debug({agents: agents.map((a) => a.handle), team: Boolean(team), post: post.id}, 'agent run queued');
    });
}
