// Captain joins a group chat on its own when it can help, without anyone
// writing @captain. After a person's message that no agent picked up, a cheap
// model reads the recent conversation and answers YES or NO; on YES, Captain
// answers in that message's thread (or plans the work, like @captain).
//
// Kept quiet on purpose:
// - only messages from people, with no @mentions (a message to someone else
//   isn't Captain's business), and not thanks, "ok" or other one-liners;
// - a few seconds later, and only if nobody has written since;
// - not while an agent is already working on that conversation, and at most
//   once every few minutes per chat;
// - each chat can turn it off ("Captain joins in" in the chat's header);
// - never in demo mode (no model to judge with).
// Once Captain has joined a thread, replies there continue with it, as for
// any agent (triggers.ts).

import type {Ctx} from '../app/context.js';
import {config} from '../config.js';
import {toChannel as publishToChannel} from '../app/events.js';
import {tx} from '../db/index.js';
import {listAgents} from '../store/agents.js';
import {addChannelMember, getChannel, listChannelMemberIds} from '../store/channels.js';
import {getPost} from '../store/posts.js';
import {createRun} from '../store/runs.js';
import {getWorkspace} from '../store/workspaces.js';
import {now} from '../util/ids.js';
import {log} from '../util/log.js';

import {joinInSystem} from './prompts.js';

const CONTEXT_MESSAGES = 12;
const ONE_LINERS = /^(ok|okay|k|kk|thanks|thank you|thx|ty|lol|lmao|haha+|nice|cool|great|awesome|yes|yep|yeah|yup|no|nope|sure|done|gm|gn|hi|hey|hello|bye|see you|sounds good|got it|on it|will do|agreed|\+1|[\p{Emoji}\s]+)[!.\s]*$/iu;

// Worth asking the model about at all.
export function worthConsidering(text: string): boolean {
    const t = text.trim();
    return t.length >= 12 && !ONE_LINERS.test(t);
}

type Line = {name: string; message: string; isBot: boolean};

export async function considerJoining(ctx: Ctx, postId: string): Promise<void> {
    if (ctx.router.demoMode) {
        return;
    }
    const post = await getPost(ctx.sql, postId);
    if (!post || post.deletedAt) {
        return;
    }
    const channel = await getChannel(ctx.sql, post.channelId);
    if (!channel || channel.deletedAt || channel.type === 'D' || !channel.captainJoinsIn) {
        return;
    }
    const agents = (await listAgents(ctx.sql, channel.workspaceId)).filter((a) => a.enabled);
    const captain = agents.find((a) => a.isCoordinator);
    if (!captain) {
        return;
    }
    const root = post.rootId ?? post.id;
    // Already being handled here, or Captain joined in a moment ago.
    const [busy] = await ctx.sql`
        select 1 from runs
        where channel_id = ${channel.id}
          and ((root_post_id = ${root} and status in ('queued', 'planning', 'running', 'waiting_approval'))
               or (unprompted and created_at > ${now() - config.agents.joinInCooldownMs}))
        limit 1`;
    if (busy) {
        return;
    }
    // Someone wrote again since: that message gets its own look.
    const [newer] = await ctx.sql`
        select 1 from posts p join users u on u.id = p.user_id
        where p.channel_id = ${channel.id} and p.deleted_at is null and p.created_at > ${post.createdAt} and not u.is_bot
          and ${post.rootId ? ctx.sql`p.root_id = ${post.rootId}` : ctx.sql`p.root_id is null`}
        limit 1`;
    if (newer) {
        return;
    }

    // The conversation so far: the thread, or the chat's latest messages.
    const rows = await ctx.sql`
        select u.display_name, u.is_bot, p.message from posts p join users u on u.id = p.user_id
        where p.channel_id = ${channel.id} and p.deleted_at is null and p.type = '' and p.created_at <= ${post.createdAt}
          and ${post.rootId ? ctx.sql`(p.root_id = ${post.rootId} or p.id = ${post.rootId})` : ctx.sql`p.root_id is null`}
        order by p.created_at desc limit ${CONTEXT_MESSAGES}`;
    const lines: Line[] = rows.reverse().map((r) => ({name: String(r.displayName), message: String(r.message), isBot: Boolean(r.isBot)}));
    const transcript = lines.map((l) => `${l.name}${l.isBot ? ' (AI agent)' : ''}: ${l.message.slice(0, 1500)}`).join('\n');
    const ws = await getWorkspace(ctx.sql, channel.workspaceId);

    let yes = false;
    try {
        const res = await ctx.router.complete({
            workspaceId: channel.workspaceId, purpose: 'classify', tier: 'easy', maxTokens: 4, temperature: 0,
            messages: [
                {role: 'system', content: joinInSystem(captain, agents.filter((a) => !a.isCoordinator), ws?.name ?? 'Captain')},
                {role: 'user', content: `Group chat: ${channel.displayName}\n\n${transcript}`},
            ],
            attribution: {agentId: captain.id, userId: post.userId},
        });
        yes = /^\W*yes\b/i.test(res.text);
    } catch (err) {
        log.debug({err, post: post.id}, 'join-in check failed; staying quiet');
        return;
    }
    if (!yes) {
        return;
    }

    const members = new Set(await listChannelMemberIds(ctx.sql, channel.id));
    const joined = await tx(ctx.sql, async (t) => {
        // Checked again inside the transaction: two messages in a row mustn't both bring Captain in.
        const [again] = await t`
            select 1 from runs where channel_id = ${channel.id}
              and ((root_post_id = ${root} and status in ('queued', 'planning', 'running', 'waiting_approval'))
                   or (unprompted and created_at > ${now() - config.agents.joinInCooldownMs}))
            limit 1`;
        if (again) {
            return null;
        }
        const added = !members.has(captain.userId) && (await addChannelMember(t, channel.id, captain.userId));
        const run = await createRun(t, {
            workspaceId: channel.workspaceId, channelId: channel.id, rootPostId: root, triggerPostId: post.id, team: null,
            requestedBy: post.userId, agentId: captain.id, kind: 'single', goal: post.message.slice(0, 300), unprompted: true,
        });
        await ctx.jobs.enqueue(t, 'run.start', {runId: run.id});
        return {added};
    });
    if (joined?.added) {
        await publishToChannel(ctx, ctx.sql, channel.id, {event: 'channel_member_added', data: {channelId: channel.id, userId: captain.userId}});
    }
    if (joined) {
        log.debug({post: post.id, channel: channel.id}, 'Captain joined in');
    }
}
