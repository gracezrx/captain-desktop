// The model router (Captain's Smart Router, rebuilt):
// - each call asks for a difficulty tier (easy, balanced, hard)
// - candidates: the tier's available models by priority, then lower tiers,
//   then higher ones; filtered for vision and tool use when needed
// - each model is tried on its provider routes in order; a route that keeps
//   failing is skipped for two minutes (circuit breaker)
// - every attempt is written to the usage ledger with tokens and cost, and a
//   workspace over its monthly budget gets a clear error instead of a bill

import {config} from '../config.js';
import type {Sql} from '../db/index.js';
import type {ModelInfo, Tier} from '../shared/types.js';
import {monthStart, recordUsage, spendSince} from '../store/usage.js';
import {getWorkspace} from '../store/workspaces.js';
import {paymentRequired} from '../util/errors.js';
import {log} from '../util/log.js';

import {type Catalog, costUsd, DEMO_MODEL, type ModelCfg} from './catalog.js';
import {chatCompletion} from './client.js';
import {TIERS} from './classify.js';
import {demoCompletion} from './demo.js';
import {type CallOptions, type CallResult, type ChatMessage, LlmError} from './types.js';

export type Purpose = 'reply' | 'plan' | 'step' | 'synthesis' | 'classify';

export type RouteRequest = CallOptions & {
    workspaceId: string;
    purpose: Purpose;
    tier: Tier;
    pinnedModel?: string | null;
    needVision?: boolean;
    attribution?: {userId?: string | null; agentId?: string | null; runId?: string | null; stepId?: string | null};
};

export type RoutedResult = CallResult & {modelId: string; provider: string; tier: Tier; costUsd: number; demo: boolean};

type Health = {fails: number; until: number; lastError: string | null};
const FAILS_TO_OPEN = 3;
const OPEN_MS = 120_000;

export class Router {
    private health = new Map<string, Health>();
    private readonly sql: Sql;
    readonly catalog: Catalog;

    constructor(sql: Sql, catalog: Catalog) {
        this.sql = sql;
        this.catalog = catalog;
    }

    get demoMode(): boolean {
        return !this.catalog.anyConfigured() && config.llm.demoWhenUnconfigured;
    }

    modelHealth(modelId: string): {healthy: boolean; lastError: string | null} {
        let lastError: string | null = null;
        let healthy = true;
        for (const [key, h] of this.health) {
            if (key.startsWith(`${modelId}|`)) {
                lastError = h.lastError ?? lastError;
                if (h.until > Date.now()) {
                    healthy = false;
                }
            }
        }
        return {healthy, lastError};
    }

    models(): ModelInfo[] {
        return this.catalog.info((id) => this.modelHealth(id));
    }

    // Which models to try, best first.
    candidates(req: Pick<RouteRequest, 'tier' | 'pinnedModel' | 'needVision' | 'tools'>): ModelCfg[] {
        const idx = TIERS.indexOf(req.tier);
        const order: Tier[] = [req.tier, ...TIERS.slice(0, idx).reverse(), ...TIERS.slice(idx + 1)];
        const available = this.catalog.available().filter((m) => (!req.needVision || m.vision) && (!req.tools?.length || m.tools));
        const out: ModelCfg[] = [];
        const pinned = req.pinnedModel ? available.find((m) => m.id === req.pinnedModel) : undefined;
        if (pinned) {
            out.push(pinned);
        }
        for (const tier of order) {
            out.push(...available.filter((m) => m.tier === tier && m !== pinned).sort((a, b) => b.priority - a.priority));
        }
        return out;
    }

    private async checkBudget(workspaceId: string): Promise<void> {
        const ws = await getWorkspace(this.sql, workspaceId);
        if (ws?.monthlyBudgetUsd === null || ws?.monthlyBudgetUsd === undefined) {
            return;
        }
        const spent = await spendSince(this.sql, workspaceId, monthStart());
        if (spent >= ws.monthlyBudgetUsd) {
            throw paymentRequired(`This workspace has used its $${ws.monthlyBudgetUsd.toFixed(2)} AI budget for the month. An admin can raise it in Settings → Models.`);
        }
    }

    async complete(req: RouteRequest): Promise<RoutedResult> {
        await this.checkBudget(req.workspaceId);
        let list = this.candidates(req);
        let messages = req.messages;
        if (!list.length && req.needVision) {
            // No model can see images: describe them instead of failing.
            messages = withoutImages(messages);
            list = this.candidates({...req, needVision: false});
        }
        if (!list.length) {
            if (!config.llm.demoWhenUnconfigured) {
                throw new LlmError('No AI model is set up yet. Add a provider key (see Settings → Models).', 0, false);
            }
            return this.runDemo(req);
        }

        let lastError: unknown = null;
        for (const model of list) {
            for (const route of this.catalog.routesFor(model)) {
                const key = `${model.id}|${route.providerId}`;
                const h = this.health.get(key);
                if (h && h.until > Date.now()) {
                    continue;
                }
                const started = Date.now();
                try {
                    const res = await chatCompletion(
                        {baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.upstream, headers: route.headers},
                        {...req, messages, tools: model.tools ? req.tools : undefined},
                    );
                    const cost = costUsd(model, res.tokensIn, res.tokensOut);
                    this.health.delete(key);
                    await this.record(req, model.id, route.providerId, res.tokensIn, res.tokensOut, cost, Date.now() - started, true, null);
                    return {...res, modelId: model.id, provider: route.providerId, tier: model.tier, costUsd: cost, demo: false};
                } catch (e) {
                    const err = e instanceof LlmError ? e : new LlmError((e as Error).message);
                    if (req.signal?.aborted || err.message === 'cancelled') {
                        throw err;
                    }
                    lastError = err;
                    const prev = this.health.get(key) ?? {fails: 0, until: 0, lastError: null};
                    const fails = prev.fails + 1;
                    this.health.set(key, {fails, until: fails >= FAILS_TO_OPEN ? Date.now() + OPEN_MS : 0, lastError: err.message.slice(0, 300)});
                    await this.record(req, model.id, route.providerId, 0, 0, 0, Date.now() - started, false, err.message.slice(0, 500));
                    log.warn({model: model.id, provider: route.providerId, err: err.message}, 'model call failed; trying the next route');
                    req.onText?.(''); // the next attempt starts its text over
                }
            }
        }
        throw new LlmError(`Every model we tried failed. Last error: ${(lastError as Error)?.message ?? 'unknown'}`, 0, true);
    }

    private async runDemo(req: RouteRequest): Promise<RoutedResult> {
        const started = Date.now();
        const res = await demoCompletion(req);
        await this.record(req, DEMO_MODEL.id, 'demo', res.tokensIn, res.tokensOut, 0, Date.now() - started, true, null);
        return {...res, modelId: DEMO_MODEL.id, provider: 'demo', tier: req.tier, costUsd: 0, demo: true};
    }

    private async record(req: RouteRequest, modelId: string, provider: string, tokensIn: number, tokensOut: number, cost: number, latencyMs: number, ok: boolean, error: string | null): Promise<void> {
        const a = req.attribution ?? {};
        await recordUsage(this.sql, {
            workspaceId: req.workspaceId, userId: a.userId ?? null, agentId: a.agentId ?? null, runId: a.runId ?? null, stepId: a.stepId ?? null,
            modelId, provider, tier: req.tier, purpose: req.purpose, tokensIn, tokensOut, costUsd: cost, latencyMs, ok, error,
        }).catch((err) => log.error({err}, 'usage write failed'));
    }
}

export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => {
        if (m.role !== 'user' || typeof m.content === 'string') {
            return m;
        }
        const text = m.content.map((p) => (p.type === 'text' ? p.text : '[an image was attached, but no image-capable model is available]')).join('\n');
        return {role: 'user', content: text};
    });
}
