// Which difficulty tier a call needs. The agent's own tier is the floor
// ("auto" means the router decides from the request alone), raised by the
// heuristics in llm/classify.ts and, optionally, by a cheap model's opinion.

import type {Ctx} from '../app/context.js';
import {config} from '../config.js';
import {classifyDifficulty, maxTier, TIERS} from '../llm/classify.js';
import type {Purpose} from '../llm/router.js';
import type {Tier} from '../shared/types.js';
import type {AgentRow} from '../store/agents.js';
import {log} from '../util/log.js';

import {classifierSystem} from './prompts.js';

const PURPOSE_BASE: Record<Purpose, Tier> = {reply: 'easy', step: 'easy', plan: 'balanced', synthesis: 'balanced', classify: 'easy'};

export async function chooseTier(ctx: Ctx, workspaceId: string, agent: AgentRow, text: string, purpose: Purpose, channelId: string | null = null): Promise<Tier> {
    const base = agent.tier === 'auto' ? PURPOSE_BASE[purpose] : maxTier(agent.tier, PURPOSE_BASE[purpose]);
    let tier = classifyDifficulty(text, base);
    if (config.llm.llmClassifier && tier !== 'hard' && text.length > 200 && !ctx.router.demoMode) {
        try {
            const res = await ctx.router.complete({
                workspaceId, purpose: 'classify', tier: 'easy', maxTokens: 4, temperature: 0,
                messages: [{role: 'system', content: classifierSystem()}, {role: 'user', content: text.slice(0, 4000)}],
                attribution: {agentId: agent.id, channelId},
            });
            const word = res.text.trim().toLowerCase().replace(/[^a-z]/g, '') as Tier;
            if (TIERS.includes(word)) {
                tier = maxTier(tier, word);
            }
        } catch (err) {
            log.debug({err}, 'classifier call failed; keeping the heuristic tier');
        }
    }
    return tier;
}
