// Queries behind the Home dashboard. Runs are limited to channels the person
// is in (the same rule as reading the runs in a channel).

import type {Db} from '../db/index.js';
import type {DashboardUsage, TokenTotals} from '../shared/types.js';

import type {RunRow} from './runs.js';
import {monthStart} from './usage.js';

const DAY = 86_400_000;
const ACTIVE = ['queued', 'planning', 'running', 'waiting_approval'];
const FINISHED = ['succeeded', 'failed', 'cancelled'];

// Local days: offsetMin is the browser's getTimezoneOffset() (minutes behind UTC).
export function localDayStart(at: number, offsetMin: number): number {
    const shift = offsetMin * 60_000;
    return Math.floor((at - shift) / DAY) * DAY + shift;
}

export async function activeRuns(db: Db, workspaceId: string, userId: string, limit = 20): Promise<RunRow[]> {
    return (await db`
        select r.* from runs r
        join channel_members m on m.channel_id = r.channel_id and m.user_id = ${userId}
        join channels c on c.id = r.channel_id and c.deleted_at is null
        where r.workspace_id = ${workspaceId} and r.status in ${db(ACTIVE)}
        order by r.created_at desc limit ${limit}`) as unknown as RunRow[];
}

export async function recentRuns(db: Db, workspaceId: string, userId: string, since: number, limit = 12): Promise<RunRow[]> {
    return (await db`
        select r.* from runs r
        join channel_members m on m.channel_id = r.channel_id and m.user_id = ${userId}
        join channels c on c.id = r.channel_id and c.deleted_at is null
        where r.workspace_id = ${workspaceId} and r.status in ${db(FINISHED)} and r.updated_at >= ${since}
        order by r.updated_at desc limit ${limit}`) as unknown as RunRow[];
}

export async function runCounts(db: Db, workspaceId: string, userId: string, today: number, week: number): Promise<{active: number; waiting: number; doneToday: number; failedToday: number; doneWeek: number}> {
    const [row] = await db`
        select
            count(*) filter (where r.status in ${db(ACTIVE)})::int as active,
            count(*) filter (where r.status = 'waiting_approval')::int as waiting,
            count(*) filter (where r.status = 'succeeded' and r.updated_at >= ${today})::int as done_today,
            count(*) filter (where r.status = 'failed' and r.updated_at >= ${today})::int as failed_today,
            count(*) filter (where r.status = 'succeeded')::int as done_week
        from runs r
        join channel_members m on m.channel_id = r.channel_id and m.user_id = ${userId}
        join channels c on c.id = r.channel_id and c.deleted_at is null
        where r.workspace_id = ${workspaceId} and (r.status in ${db(ACTIVE)} or r.updated_at >= ${week})`;
    return {active: row.active, waiting: row.waiting, doneToday: row.doneToday, failedToday: row.failedToday, doneWeek: row.doneWeek};
}

export async function tokensByRun(db: Db, workspaceId: string, runIds: string[]): Promise<Map<string, number>> {
    if (!runIds.length) {
        return new Map();
    }
    const rows = await db`
        select run_id, coalesce(sum(tokens_in + tokens_out), 0)::bigint as tokens
        from usage_events where workspace_id = ${workspaceId} and run_id in ${db(runIds)}
        group by run_id`;
    return new Map(rows.map((r) => [r.runId as string, Number(r.tokens)]));
}

const totals = (r: Record<string, unknown>, k: string): TokenTotals => ({
    tokensIn: Number(r[`${k}In`] ?? 0), tokensOut: Number(r[`${k}Out`] ?? 0), usd: Number(r[`${k}Usd`] ?? 0), calls: Number(r[`${k}Calls`] ?? 0),
});

export async function usageOverview(db: Db, workspaceId: string, budgetUsd: number | null, offsetMin: number, at = Date.now()): Promise<DashboardUsage> {
    const today = localDayStart(at, offsetMin);
    const week = today - 6 * DAY;
    const month = monthStart(at);
    const fortnight = today - 13 * DAY;
    const from = Math.min(month, fortnight);
    const shift = offsetMin * 60_000;
    // Three independent queries, sent together: a hosted database is a round trip away.
    const [[row], days, byAgent] = await Promise.all([db`
        select
            coalesce(sum(tokens_in) filter (where created_at >= ${today}), 0)::bigint as today_in,
            coalesce(sum(tokens_out) filter (where created_at >= ${today}), 0)::bigint as today_out,
            coalesce(sum(cost_usd) filter (where created_at >= ${today}), 0)::float8 as today_usd,
            (count(*) filter (where created_at >= ${today}))::int as today_calls,
            coalesce(sum(tokens_in) filter (where created_at >= ${week}), 0)::bigint as week_in,
            coalesce(sum(tokens_out) filter (where created_at >= ${week}), 0)::bigint as week_out,
            coalesce(sum(cost_usd) filter (where created_at >= ${week}), 0)::float8 as week_usd,
            (count(*) filter (where created_at >= ${week}))::int as week_calls,
            coalesce(sum(tokens_in) filter (where created_at >= ${month}), 0)::bigint as month_in,
            coalesce(sum(tokens_out) filter (where created_at >= ${month}), 0)::bigint as month_out,
            coalesce(sum(cost_usd) filter (where created_at >= ${month}), 0)::float8 as month_usd,
            (count(*) filter (where created_at >= ${month}))::int as month_calls,
            (count(*) filter (where created_at >= ${today} and not ok))::int as errors_today
        from usage_events where workspace_id = ${workspaceId} and created_at >= ${from}`, db`
        select floor((created_at - ${shift})::float8 / ${DAY})::bigint as d,
               coalesce(sum(tokens_in + tokens_out), 0)::bigint as tokens, coalesce(sum(cost_usd), 0)::float8 as usd
        from usage_events where workspace_id = ${workspaceId} and created_at >= ${fortnight}
        group by d`, db`
        select agent_id, coalesce(sum(tokens_in + tokens_out), 0)::bigint as tokens, coalesce(sum(cost_usd), 0)::float8 as usd
        from usage_events where workspace_id = ${workspaceId} and created_at >= ${month}
        group by agent_id order by tokens desc`]);
    const byDay = new Map(days.map((d) => [Number(d.d) * DAY + shift, {tokens: Number(d.tokens), usd: Number(d.usd)}]));
    return {
        today: totals(row, 'today'),
        week: totals(row, 'week'),
        month: totals(row, 'month'),
        budgetUsd,
        daily: Array.from({length: 14}, (_, i) => {
            const day = fortnight + i * DAY;
            return {day, ...(byDay.get(day) ?? {tokens: 0, usd: 0})};
        }),
        byAgent: byAgent.map((r) => ({agentId: (r.agentId as string) ?? null, tokens: Number(r.tokens), usd: Number(r.usd)})),
        errorsToday: Number(row.errorsToday),
    };
}
