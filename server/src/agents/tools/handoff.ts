// ask_agent: hand a question to a teammate mid-task. The teammate answers in
// the thread under its own name (so people see the handoff) and the answer
// comes back to the asking agent. The teammate answers without tools, which
// keeps handoffs from chaining forever.

import {savePost} from '../../app/posts.js';
import {listAgents} from '../../store/agents.js';
import {getUser} from '../../store/users.js';
import {getWorkspace} from '../../store/workspaces.js';
import {agentSystem} from '../prompts.js';
import {chooseTier} from '../tiering.js';

import {str, type Tool} from './types.js';

export const askAgent: Tool = {
    name: 'ask_agent',
    description: 'Ask a teammate agent for help with part of the task (for example @researcher for facts, @writer for copy). They answer in the thread and you get their answer back.',
    parameters: {
        type: 'object',
        properties: {agent: {type: 'string', description: 'The teammate\'s handle, without @'}, request: {type: 'string', description: 'What you need from them, with the context they need'}},
        required: ['agent', 'request'],
    },
    external: false,
    available: () => true,
    async run(tc, args) {
        const handle = str(args.agent, 60).replace(/^@/, '').toLowerCase();
        const request = str(args.request, 8000);
        const team = (await listAgents(tc.ctx.sql, tc.channel.workspaceId)).filter((a) => a.enabled);
        const target = team.find((a) => a.handle.toLowerCase() === handle);
        if (!target || target.id === tc.agent.id) {
            return {content: `There's no other agent called @${handle}. The team: ${team.filter((a) => a.id !== tc.agent.id).map((a) => `@${a.handle}`).join(', ')}.`};
        }
        const bot = await getUser(tc.ctx.sql, target.userId);
        const ws = await getWorkspace(tc.ctx.sql, tc.channel.workspaceId);
        if (!bot || !ws) {
            return {content: `@${handle} isn't available right now.`};
        }
        const res = await tc.ctx.router.complete({
            workspaceId: tc.channel.workspaceId,
            purpose: 'step',
            tier: await chooseTier(tc.ctx, tc.channel.workspaceId, target, request, 'step'),
            pinnedModel: target.model,
            messages: [
                {role: 'system', content: agentSystem(target, {workspaceName: ws.name, channel: tc.channel, requesterName: tc.requester.displayName}, [])},
                {role: 'user', content: `${tc.agent.name} (a teammate agent) asks: ${request}`},
            ],
            signal: tc.signal,
            attribution: {userId: tc.requester.id, agentId: target.id, runId: tc.run.id, stepId: tc.stepId},
        });
        const answer = res.text.trim() || '(no answer)';
        if (tc.channel.deletedAt === null) {
            await savePost(tc.ctx, bot, tc.channel, {
                message: answer,
                rootId: tc.threadRoot,
                props: {model: {id: res.modelId, provider: res.provider, tier: res.tier, costUsd: res.costUsd}, handoff: {from: tc.agent.id, runId: tc.run.id}},
            });
        }
        return {content: `@${target.handle} answered:\n${answer}`};
    },
};
