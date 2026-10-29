// The Home dashboard: what agents are working on, what finished, what's
// waiting on you, and (for owners and admins) tokens burned.

import type {ActivityRun, Dashboard} from '../shared/types.js';
import {activeRuns, localDayStart, recentRuns, runCounts, tokensByRun, usageOverview} from '../store/dashboard.js';
import {listSteps, type RunRow, toRun} from '../store/runs.js';
import type {UserRow} from '../store/users.js';
import {getWorkspace} from '../store/workspaces.js';

import type {Ctx} from './context.js';
import {atLeast, requireWorkspaceRole} from './permissions.js';

const DAY = 86_400_000;

export function parseOffset(raw: unknown): number {
    const n = Number(raw);
    return Number.isInteger(n) && Math.abs(n) <= 14 * 60 ? n : 0;
}

export async function dashboard(ctx: Ctx, user: UserRow, workspaceId: string, offsetMin: number): Promise<Dashboard> {
    const role = await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    const at = Date.now();
    const today = localDayStart(at, offsetMin);
    const week = today - 6 * DAY;
    const [active, recent, counts] = await Promise.all([
        activeRuns(ctx.sql, workspaceId, user.id),
        recentRuns(ctx.sql, workspaceId, user.id, week),
        runCounts(ctx.sql, workspaceId, user.id, today, week),
    ]);
    // Tokens and spend are for owners and admins (as in Settings → Models & spend).
    const admin = atLeast(role, 'admin');
    const tokens = admin ? await tokensByRun(ctx.sql, workspaceId, [...active, ...recent].map((r) => r.id)) : new Map<string, number>();
    const shape = async (r: RunRow): Promise<ActivityRun> => {
        const run = toRun(r, await listSteps(ctx.sql, r.id));
        return {
            ...run,
            costUsd: admin ? run.costUsd : 0,
            steps: admin ? run.steps : run.steps.map((st) => ({...st, costUsd: 0})),
            agentId: r.agentId, requestedBy: r.requestedBy, team: r.team ?? null, triggerPostId: r.triggerPostId, tokens: tokens.get(r.id) ?? 0,
        };
    };
    let usage = null;
    if (admin) {
        const ws = await getWorkspace(ctx.sql, workspaceId);
        usage = await usageOverview(ctx.sql, workspaceId, ws?.monthlyBudgetUsd ?? null, offsetMin, at);
    }
    return {active: await Promise.all(active.map(shape)), recent: await Promise.all(recent.map(shape)), counts, usage};
}
