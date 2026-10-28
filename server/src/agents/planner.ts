// Captain's planner: answer directly, or split the request into steps for
// specialist agents. The plan is checked before it runs: known agents only,
// unique step ids, dependencies that exist and contain no cycles.

import {z} from 'zod';

import type {Ctx} from '../app/context.js';
import {config} from '../config.js';
import {classifyDifficulty} from '../llm/classify.js';
import type {ChatMessage} from '../llm/types.js';
import type {AgentRow} from '../store/agents.js';
import {log} from '../util/log.js';

import {plannerSystem, type Setting} from './prompts.js';
import {chooseTier} from './tiering.js';

export type PlannedStep = {id: string; agentId: string; title: string; instructions: string; dependsOn: string[]};
export type Plan = {mode: 'direct'} | {mode: 'plan'; goal: string; steps: PlannedStep[]};

const planSchema = z.union([
    z.object({mode: z.literal('direct')}).passthrough(),
    z.object({
        mode: z.literal('plan'),
        goal: z.string().min(1).max(300),
        steps: z.array(z.object({
            id: z.string().min(1).max(20),
            agent: z.string().min(1).max(60),
            title: z.string().min(1).max(120),
            instructions: z.string().min(1).max(4000),
            dependsOn: z.array(z.string()).default([]),
        })).min(1),
    }).passthrough(),
]);

function parseJson(text: string): unknown {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return JSON.parse(start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed);
}

export function validatePlan(raw: unknown, team: AgentRow[], maxSteps: number): Plan {
    const parsed = planSchema.parse(raw);
    if (parsed.mode === 'direct') {
        return {mode: 'direct'};
    }
    const byHandle = new Map(team.map((a) => [a.handle.toLowerCase(), a]));
    const steps = parsed.steps.slice(0, maxSteps);
    const ids = new Set<string>();
    const out: PlannedStep[] = [];
    for (const s of steps) {
        const agent = byHandle.get(s.agent.replace(/^@/, '').toLowerCase());
        if (!agent) {
            throw new Error(`unknown agent ${s.agent}`);
        }
        if (ids.has(s.id)) {
            throw new Error(`duplicate step id ${s.id}`);
        }
        ids.add(s.id);
        out.push({id: s.id, agentId: agent.id, title: s.title, instructions: s.instructions, dependsOn: [...new Set(s.dependsOn)]});
    }
    for (const s of out) {
        if (s.dependsOn.some((d) => !ids.has(d) || d === s.id)) {
            throw new Error(`step ${s.id} depends on a missing step`);
        }
    }
    // No cycles: repeatedly remove steps whose dependencies are all removed.
    const done = new Set<string>();
    let progress = true;
    while (progress) {
        progress = false;
        for (const s of out) {
            if (!done.has(s.id) && s.dependsOn.every((d) => done.has(d))) {
                done.add(s.id);
                progress = true;
            }
        }
    }
    if (done.size !== out.length) {
        throw new Error('the plan has a dependency cycle');
    }
    if (out.length === 1) {
        return {mode: 'direct'};
    }
    return {mode: 'plan', goal: parsed.goal, steps: out};
}

export async function makePlan(ctx: Ctx, args: {captain: AgentRow; team: AgentRow[]; setting: Setting; conversation: ChatMessage[]; text: string; workspaceId: string; runId: string; requesterId: string; signal: AbortSignal}): Promise<Plan> {
    const specialists = args.team.filter((a) => a.enabled && !a.isCoordinator);
    // Quick questions and small talk never need a team.
    if (specialists.length < 2 || (args.text.length < 60 && classifyDifficulty(args.text) === 'easy')) {
        return {mode: 'direct'};
    }
    try {
        const res = await ctx.router.complete({
            workspaceId: args.workspaceId,
            purpose: 'plan',
            tier: await chooseTier(ctx, args.workspaceId, args.captain, args.text, 'plan'),
            pinnedModel: args.captain.model,
            json: true,
            temperature: 0.2,
            maxTokens: 1500,
            messages: [{role: 'system', content: plannerSystem(args.captain, specialists, args.setting, config.agents.maxSteps)}, ...args.conversation.slice(-8)],
            signal: args.signal,
            attribution: {userId: args.requesterId, agentId: args.captain.id, runId: args.runId},
        });
        return validatePlan(parseJson(res.text), specialists, config.agents.maxSteps);
    } catch (e) {
        if (args.signal.aborted) {
            throw e;
        }
        if ((e as {status?: number}).status === 402) {
            throw e;
        }
        log.info({err: (e as Error).message}, 'planning failed; Captain answers directly');
        return {mode: 'direct'};
    }
}
