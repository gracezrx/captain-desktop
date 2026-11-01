import type {Db} from '../db/index.js';
import type {Tier, UsageSummary} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type UsageEvent = {
    workspaceId: string;
    userId: string | null;
    agentId: string | null;
    runId: string | null;
    stepId: string | null;
    channelId?: string | null; // the chat the work was for
    modelId: string;
    provider: string;
    tier: Tier;
    purpose: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    ok: boolean;
    error: string | null;
};

export async function recordUsage(db: Db, e: UsageEvent): Promise<void> {
    await db`
        insert into usage_events (id, workspace_id, user_id, agent_id, run_id, step_id, channel_id, model_id, provider, tier, purpose, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, created_at)
        values (${newId()}, ${e.workspaceId}, ${e.userId}, ${e.agentId}, ${e.runId}, ${e.stepId}, ${e.channelId ?? null}, ${e.modelId}, ${e.provider}, ${e.tier}, ${e.purpose},
                ${e.tokensIn}, ${e.tokensOut}, ${e.costUsd}, ${e.latencyMs}, ${e.ok}, ${e.error}, ${now()})`;
}

// Budgets reset on the first of each month, UTC.
export function monthStart(t = now()): number {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export async function spendSince(db: Db, workspaceId: string, since: number): Promise<number> {
    const [row] = await db`select coalesce(sum(cost_usd), 0)::float8 as usd from usage_events where workspace_id = ${workspaceId} and created_at >= ${since}`;
    return Number(row.usd);
}

export async function usageSummary(db: Db, workspaceId: string, budgetUsd: number | null, since = monthStart()): Promise<UsageSummary> {
    const byModel = await db`
        select model_id, coalesce(sum(cost_usd), 0)::float8 as usd, count(*)::int as calls,
               coalesce(sum(tokens_in), 0)::int as tokens_in, coalesce(sum(tokens_out), 0)::int as tokens_out
        from usage_events where workspace_id = ${workspaceId} and created_at >= ${since}
        group by model_id order by usd desc`;
    const byAgent = await db`
        select agent_id, coalesce(sum(cost_usd), 0)::float8 as usd, count(*)::int as calls
        from usage_events where workspace_id = ${workspaceId} and created_at >= ${since}
        group by agent_id order by usd desc`;
    // Failed model calls in the past week, newest first (what went wrong, and where).
    const errors = await db`
        select created_at, model_id, provider, purpose, agent_id, error
        from usage_events where workspace_id = ${workspaceId} and not ok and created_at >= ${Date.now() - 7 * 86_400_000}
        order by created_at desc limit 12`;
    const totalUsd = byModel.reduce((s, r) => s + Number(r.usd), 0);
    const calls = byModel.reduce((s, r) => s + Number(r.calls), 0);
    return {
        periodStart: since,
        totalUsd,
        budgetUsd,
        calls,
        byModel: byModel.map((r) => ({modelId: r.modelId as string, usd: Number(r.usd), calls: Number(r.calls), tokensIn: Number(r.tokensIn), tokensOut: Number(r.tokensOut)})),
        byAgent: byAgent.map((r) => ({agentId: (r.agentId as string) ?? null, usd: Number(r.usd), calls: Number(r.calls)})),
        recentErrors: errors.map((r) => ({
            at: Number(r.createdAt), modelId: r.modelId as string, provider: r.provider as string, purpose: r.purpose as string,
            agentId: (r.agentId as string) ?? null, error: String(r.error ?? '').slice(0, 300),
        })),
    };
}
