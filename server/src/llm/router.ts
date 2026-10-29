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
const RATE_LIMIT_WAIT_MS = 1500;
const CREDIT_CAP_MS = 10 * 60_000;

function defaultMaxTokens(purpose: Purpose): number {
    return purpose === 'classify' ? 16 : purpose === 'plan' ? 1500 : config.llm.maxOutputTokens;
}

function price(m: ModelCfg): number {
    return m.priceInPerM + m.priceOutPerM * 4; // answers cost more than prompts
}

// "This request requires more credits, or fewer max_tokens. You requested up
// to 32000 tokens, but can only afford 1200." (OpenRouter), or a plain 402.
export function creditShortfall(err: LlmError): {affordable: number | null} | null {
    const m = err.message;
    if (err.status !== 402 && !/more credits|fewer max_tokens|can only afford|insufficient (credits|balance|quota)/i.test(m)) {
        return null;
    }
    const n = m.match(/can only afford (\d+)/i);
    return {affordable: n ? Number(n[1]) : null};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
        }, {once: true});
    });
}

export class Router {
    private health = new Map<string, Health>();
    private readonly sql: Sql;
    readonly catalog: Catalog;

    constructor(sql: Sql, catalog: Catalog) {
        this.sql = sql;
        this.catalog = catalog;
    }

    // A provider's key changed: give its routes a fresh start.
    resetProviders(providerIds: string[]): void {
        for (const key of [...this.health.keys()]) {
            if (providerIds.some((id) => key.endsWith(`|${id}`))) {
                this.health.delete(key);
            }
        }
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

        // Every call asks for a bounded answer (see config.llm.maxOutputTokens).
        let maxTokens = req.maxTokens ?? defaultMaxTokens(req.purpose);
        let lowCredit = false;
        let lastError: unknown = null;
        const queue = [...list];
        while (queue.length) {
            const model = queue.shift()!;
            for (const route of this.catalog.routesFor(model)) {
                const key = `${model.id}|${route.providerId}`;
                const h = this.health.get(key);
                if (h && h.until > Date.now()) {
                    continue;
                }
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const started = Date.now();
                    const ask = this.affordable(route.providerId, maxTokens);
                    try {
                        const res = await this.withSlot(route.providerId, req.signal, () => chatCompletion(
                            {baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.upstream, headers: route.headers},
                            {...req, messages, maxTokens: ask, tools: model.tools ? req.tools : undefined},
                        ));
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
                        await this.record(req, model.id, route.providerId, 0, 0, 0, Date.now() - started, false, err.message.slice(0, 500));
                        req.onText?.(''); // the next attempt starts its text over

                        // Rate limited: wait a moment and try the same route again.
                        if (err.status === 429 && attempt < 3) {
                            log.info({model: model.id, provider: route.providerId, attempt}, 'rate limited; retrying shortly');
                            await sleep(Math.min(err.retryAfterMs ?? RATE_LIMIT_WAIT_MS * attempt, 8000), req.signal);
                            continue;
                        }
                        // Not enough credit for this long an answer: ask for a
                        // shorter one, then prefer cheaper models.
                        const credit = creditShortfall(err);
                        if (credit) {
                            lowCredit = true;
                            const smaller = credit.affordable && credit.affordable >= 256 ? Math.floor(credit.affordable * 0.8) : Math.min(ask, 1000);
                            if (smaller < ask && attempt < 3) {
                                log.info({model: model.id, from: ask, to: smaller}, 'low credit; asking for a shorter answer');
                                maxTokens = smaller;
                                // Other calls to this provider ask for no more for a while.
                                this.creditCaps.set(route.providerId, {tokens: smaller, until: Date.now() + CREDIT_CAP_MS});
                                continue;
                            }
                            queue.sort((a, b) => price(a) - price(b));
                            break;
                        }
                        // A failing route is skipped for a while (account-wide
                        // limits like the two above don't count against it).
                        if (err.status !== 429) {
                            const prev = this.health.get(key) ?? {fails: 0, until: 0, lastError: null};
                            const fails = prev.fails + 1;
                            this.health.set(key, {fails, until: fails >= FAILS_TO_OPEN ? Date.now() + OPEN_MS : 0, lastError: err.message.slice(0, 300)});
                        }
                        log.warn({model: model.id, provider: route.providerId, err: err.message}, 'model call failed; trying the next route');
                        break;
                    }
                }
            }
        }
        if (lowCredit) {
            throw new LlmError('The model provider says your account doesn\'t have enough credit for this. Add credit (for OpenRouter: openrouter.ai/settings/credits) and try again.', 402, false);
        }
        throw new LlmError(`Every model we tried failed. Last error: ${(lastError as Error)?.message ?? 'unknown'}`, 0, true);
    }

    // What a provider said the account can afford, remembered for a while so
    // other calls don't hit the same refusal first.
    private creditCaps = new Map<string, {tokens: number; until: number}>();

    private affordable(provider: string, maxTokens: number): number {
        const cap = this.creditCaps.get(provider);
        if (!cap || cap.until <= Date.now()) {
            return maxTokens;
        }
        return Math.min(maxTokens, cap.tokens);
    }

    // At most N calls at once per provider; the rest wait their turn.
    private slots = new Map<string, {active: number; waiting: (() => void)[]}>();

    private async withSlot<T>(provider: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
        let s = this.slots.get(provider);
        if (!s) {
            s = {active: 0, waiting: []};
            this.slots.set(provider, s);
        }
        while (s.active >= Math.max(1, config.llm.maxConcurrentPerProvider)) {
            await new Promise<void>((resolve) => s!.waiting.push(resolve));
            if (signal?.aborted) {
                s.waiting.shift()?.(); // pass the turn on
                throw new LlmError('cancelled', 0, false);
            }
        }
        s.active++;
        try {
            return await fn();
        } finally {
            s.active--;
            s.waiting.shift()?.();
        }
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
