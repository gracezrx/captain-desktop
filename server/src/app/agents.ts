// Agents, runs, models and spend, as the API sees them.

import {z} from 'zod';

import {createAgentWithBot} from '../agents/builtins.js';
import type {Orchestrator} from '../agents/orchestrator.js';
import {TOOLS, toolCatalog} from '../agents/tools/index.js';
import {tx} from '../db/index.js';
import type {Agent, AgentTool, ModelInfo, Run, UsageSummary, User} from '../shared/types.js';
import {getAgent, listAgents, toAgent, updateAgent} from '../store/agents.js';
import {audit} from '../store/audit.js';
import {getChannelByName} from '../store/channels.js';
import {getRun, listRuns, listSteps, toRun} from '../store/runs.js';
import {usageSummary} from '../store/usage.js';
import {getUser, toUser, updateUser, type UserRow} from '../store/users.js';
import {getMemberRole, getWorkspace} from '../store/workspaces.js';
import {badRequest, conflict, forbidden, notFound} from '../util/errors.js';

import type {Ctx} from './context.js';
import {toWorkspace as publishToWorkspace} from './events.js';
import {atLeast, requireChannelMember, requireWorkspaceRole} from './permissions.js';

export const PORTRAITS = ['captain', 'fox', 'owl', 'panda', 'rabbit', 'cat', 'penguin'];
const RESERVED = new Set(['channel', 'all', 'here', 'everyone', 'admin', 'system']);

const tierSchema = z.enum(['auto', 'easy', 'balanced', 'hard']);
const toolsSchema = z.array(z.string()).max(TOOLS.length).refine((list) => list.every((n) => TOOLS.some((t) => t.name === n)), 'Unknown tool.');

const agentInput = z.object({
    handle: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,29}$/, 'Handles are 2–30 letters, numbers, - or _, starting with a letter.'),
    name: z.string().trim().min(1, 'Name the agent.').max(40),
    description: z.string().trim().max(200).default(''),
    instructions: z.string().trim().min(10, 'Tell the agent what it does (at least a sentence).').max(8000),
    tier: tierSchema.default('auto'),
    model: z.string().max(80).nullable().default(null),
    tools: toolsSchema.default(['search_workspace', 'read_url', 'create_document']),
    portrait: z.string().default('fox'),
});

const agentPatch = agentInput.omit({handle: true}).partial().extend({enabled: z.boolean().optional()});

function checkModel(ctx: Ctx, model: string | null | undefined): void {
    if (model && !ctx.router.catalog.get(model)) {
        throw badRequest('That model isn\'t in the catalog.');
    }
}

export async function agents(ctx: Ctx, user: UserRow, workspaceId: string): Promise<{agents: Agent[]; tools: AgentTool[]}> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    return {agents: (await listAgents(ctx.sql, workspaceId)).map(toAgent), tools: toolCatalog()};
}

export async function createAgent(ctx: Ctx, user: UserRow, workspaceId: string, input: unknown): Promise<Agent> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'admin');
    const data = agentInput.parse(input);
    if (RESERVED.has(data.handle)) {
        throw badRequest(`@${data.handle} is reserved. Pick another handle.`);
    }
    if (!PORTRAITS.includes(data.portrait)) {
        throw badRequest('Pick one of the portraits.');
    }
    checkModel(ctx, data.model);
    if ((await listAgents(ctx.sql, workspaceId)).some((a) => a.handle.toLowerCase() === data.handle)) {
        throw conflict(`There's already an agent called @${data.handle}.`);
    }
    const agent = await tx(ctx.sql, async (t) => {
        const general = await getChannelByName(t, workspaceId, 'general');
        return createAgentWithBot(t, workspaceId, {...data, builtin: false}, general ? [general.id] : []);
    });
    audit(ctx.sql, {workspaceId, userId: user.id, action: 'agent_created', target: agent.id, meta: {handle: agent.handle}});
    const bot = await getUser(ctx.sql, agent.userId);
    if (bot) {
        await publishToWorkspace(ctx, ctx.sql, workspaceId, {event: 'workspace_member_added', data: {workspaceId, user: toUser(bot), role: 'member'}});
    }
    return agent;
}

export async function editAgent(ctx: Ctx, user: UserRow, agentId: string, input: unknown): Promise<Agent> {
    const agent = await getAgent(ctx.sql, agentId);
    if (!agent) {
        throw notFound('Agent');
    }
    await requireWorkspaceRole(ctx.sql, agent.workspaceId, user.id, 'admin');
    const patch = agentPatch.parse(input);
    if (patch.portrait !== undefined && !PORTRAITS.includes(patch.portrait)) {
        throw badRequest('Pick one of the portraits.');
    }
    if (agent.isCoordinator && patch.enabled === false) {
        throw badRequest('Captain coordinates the other agents and can\'t be turned off.');
    }
    checkModel(ctx, patch.model);
    const updated = await updateAgent(ctx.sql, agentId, patch);
    if (patch.name !== undefined || patch.portrait !== undefined) {
        const bot = await updateUser(ctx.sql, agent.userId, {displayName: patch.name, portrait: patch.portrait});
        await publishToWorkspace(ctx, ctx.sql, agent.workspaceId, {event: 'user_updated', data: {user: toUser(bot)}});
    }
    audit(ctx.sql, {workspaceId: agent.workspaceId, userId: user.id, action: 'agent_updated', target: agentId, meta: patch});
    return toAgent(updated);
}

// ------------------------------------------------------------ runs

async function visibleRun(ctx: Ctx, user: UserRow, runId: string) {
    const run = await getRun(ctx.sql, runId);
    if (!run) {
        throw notFound('Run');
    }
    await requireChannelMember(ctx.sql, run.channelId, user.id);
    return run;
}

export async function runInfo(ctx: Ctx, user: UserRow, runId: string): Promise<Run> {
    const run = await visibleRun(ctx, user, runId);
    return toRun(run, await listSteps(ctx.sql, runId));
}

export async function channelRuns(ctx: Ctx, user: UserRow, channelId: string): Promise<Run[]> {
    await requireChannelMember(ctx.sql, channelId, user.id);
    const runs = await listRuns(ctx.sql, channelId, 20);
    return Promise.all(runs.map(async (r) => toRun(r, await listSteps(ctx.sql, r.id))));
}

export async function cancelRun(ctx: Ctx, orchestrator: Orchestrator, user: UserRow, runId: string): Promise<Run> {
    const run = await visibleRun(ctx, user, runId);
    if (run.requestedBy !== user.id) {
        const role = await getMemberRole(ctx.sql, run.workspaceId, user.id);
        if (!role || !atLeast(role, 'admin')) {
            throw forbidden('Only the person who asked, or an admin, can stop this.');
        }
    }
    const updated = await orchestrator.cancel(runId, user.id);
    return toRun(updated, await listSteps(ctx.sql, runId));
}

// ------------------------------------------------------------ models and spend

export async function models(ctx: Ctx, user: UserRow, workspaceId: string): Promise<{models: ModelInfo[]; demoMode: boolean}> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    return {models: ctx.router.models(), demoMode: ctx.router.demoMode};
}

export async function usage(ctx: Ctx, user: UserRow, workspaceId: string): Promise<UsageSummary> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'admin');
    const ws = await getWorkspace(ctx.sql, workspaceId);
    return usageSummary(ctx.sql, workspaceId, ws?.monthlyBudgetUsd ?? null);
}

export function botUsers(rows: UserRow[]): User[] {
    return rows.map((u) => toUser(u));
}
