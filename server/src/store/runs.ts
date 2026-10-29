import type {Db} from '../db/index.js';
import type {PlanStepStatus, Run, RunStatus, RunStep} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type RunRow = {
    id: string;
    workspaceId: string;
    channelId: string;
    rootPostId: string | null;
    triggerPostId: string | null;
    requestedBy: string;
    agentId: string;
    kind: 'single' | 'plan';
    status: RunStatus;
    goal: string;
    cardPostId: string | null;
    resultPostId: string | null;
    error: string | null;
    costUsd: number;
    team: string[] | null; // agents named in the message; Captain coordinates just them
    createdAt: number;
    updatedAt: number;
};

export type StepRow = {
    runId: string;
    id: string;
    idx: number;
    agentId: string;
    title: string;
    instructions: string;
    dependsOn: string[];
    status: PlanStepStatus;
    output: string | null;
    error: string | null;
    transcript: unknown;
    waitingApprovalId: string | null;
    postId: string | null;
    modelId: string | null;
    costUsd: number;
    startedAt: number | null;
    finishedAt: number | null;
};

export const TERMINAL_RUN: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
export const TERMINAL_STEP: PlanStepStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];

export function toRun(r: RunRow, steps: StepRow[]): Run {
    return {
        id: r.id,
        workspaceId: r.workspaceId,
        channelId: r.channelId,
        rootPostId: r.rootPostId,
        status: r.status,
        kind: r.kind,
        goal: r.goal,
        costUsd: r.costUsd,
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        steps: steps.map((s): RunStep => ({
            id: s.id, title: s.title, agentId: s.agentId, status: s.status, dependsOn: s.dependsOn, output: s.output,
            error: s.error, modelId: s.modelId, costUsd: s.costUsd, startedAt: s.startedAt, finishedAt: s.finishedAt,
        })),
    };
}

export async function createRun(db: Db, r: Pick<RunRow, 'workspaceId' | 'channelId' | 'rootPostId' | 'triggerPostId' | 'requestedBy' | 'agentId' | 'kind' | 'goal'> & {status?: RunStatus; team?: string[] | null}): Promise<RunRow> {
    const t = now();
    const [row] = await db`
        insert into runs (id, workspace_id, channel_id, root_post_id, trigger_post_id, requested_by, agent_id, kind, status, goal, team, created_at, updated_at)
        values (${newId()}, ${r.workspaceId}, ${r.channelId}, ${r.rootPostId}, ${r.triggerPostId}, ${r.requestedBy}, ${r.agentId}, ${r.kind}, ${r.status ?? 'queued'}, ${r.goal}, ${r.team?.length ? r.team : null}, ${t}, ${t})
        returning *`;
    return row as unknown as RunRow;
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
    const [row] = await db`select * from runs where id = ${id}`;
    return (row as unknown as RunRow) ?? null;
}

// Lock the run row for the rest of the transaction (serializes schedulers).
export async function lockRun(db: Db, id: string): Promise<RunRow | null> {
    const [row] = await db`select * from runs where id = ${id} for update`;
    return (row as unknown as RunRow) ?? null;
}

export async function updateRun(db: Db, id: string, patch: Partial<Pick<RunRow, 'status' | 'kind' | 'goal' | 'cardPostId' | 'resultPostId' | 'error'>>): Promise<RunRow> {
    const [row] = await db`
        update runs set
            status = case when status in ('succeeded', 'failed', 'cancelled') then status else coalesce(${patch.status ?? null}, status) end,
            kind = coalesce(${patch.kind ?? null}, kind),
            goal = coalesce(${patch.goal ?? null}, goal),
            card_post_id = coalesce(${patch.cardPostId ?? null}, card_post_id),
            result_post_id = coalesce(${patch.resultPostId ?? null}, result_post_id),
            error = case when ${patch.error !== undefined} then ${patch.error ?? null} else error end,
            updated_at = ${now()}
        where id = ${id}
        returning *`;
    return row as unknown as RunRow;
}

export async function addRunCost(db: Db, id: string, usd: number): Promise<void> {
    if (usd > 0) {
        await db`update runs set cost_usd = cost_usd + ${usd} where id = ${id}`;
    }
}

export async function listRuns(db: Db, channelId: string, limit = 20): Promise<RunRow[]> {
    return (await db`select * from runs where channel_id = ${channelId} order by created_at desc limit ${limit}`) as unknown as RunRow[];
}

// ------------------------------------------------------------ steps

export async function insertSteps(db: Db, runId: string, steps: {id: string; agentId: string; title: string; instructions: string; dependsOn: string[]}[]): Promise<void> {
    let idx = 0;
    for (const s of steps) {
        await db`
            insert into run_steps (run_id, id, idx, agent_id, title, instructions, depends_on, status)
            values (${runId}, ${s.id}, ${idx++}, ${s.agentId}, ${s.title}, ${s.instructions}, ${s.dependsOn}, 'pending')`;
    }
}

export async function listSteps(db: Db, runId: string): Promise<StepRow[]> {
    return (await db`select * from run_steps where run_id = ${runId} order by idx`) as unknown as StepRow[];
}

export async function getStep(db: Db, runId: string, stepId: string): Promise<StepRow | null> {
    const [row] = await db`select * from run_steps where run_id = ${runId} and id = ${stepId}`;
    return (row as unknown as StepRow) ?? null;
}

export async function updateStep(db: Db, runId: string, stepId: string, patch: Partial<Pick<StepRow, 'status' | 'output' | 'error' | 'postId' | 'modelId' | 'startedAt' | 'finishedAt' | 'waitingApprovalId'>> & {transcript?: unknown; addCost?: number}): Promise<StepRow> {
    const [row] = await db`
        update run_steps set
            status = case when status in ('succeeded', 'failed', 'skipped', 'cancelled') then status else coalesce(${patch.status ?? null}, status) end,
            waiting_approval_id = case when ${patch.waitingApprovalId !== undefined} then ${patch.waitingApprovalId ?? null} else waiting_approval_id end,
            output = case when ${patch.output !== undefined} then ${patch.output ?? null} else output end,
            error = case when ${patch.error !== undefined} then ${patch.error ?? null} else error end,
            post_id = coalesce(${patch.postId ?? null}, post_id),
            model_id = coalesce(${patch.modelId ?? null}, model_id),
            started_at = coalesce(${patch.startedAt ?? null}, started_at),
            finished_at = coalesce(${patch.finishedAt ?? null}, finished_at),
            transcript = case when ${patch.transcript !== undefined} then ${patch.transcript ? db.json(patch.transcript as never) : null} else transcript end,
            cost_usd = cost_usd + ${patch.addCost ?? 0}
        where run_id = ${runId} and id = ${stepId}
        returning *`;
    return row as unknown as StepRow;
}

// Claim a pending step for execution (only one worker wins).
export async function claimStep(db: Db, runId: string, stepId: string): Promise<boolean> {
    const r = await db`update run_steps set status = 'running', started_at = ${now()} where run_id = ${runId} and id = ${stepId} and status = 'pending'`;
    return r.count === 1;
}

// ------------------------------------------------------------ approvals

export type ApprovalRow = {
    id: string;
    workspaceId: string;
    channelId: string;
    runId: string | null;
    stepId: string | null;
    postId: string | null;
    agentId: string | null;
    tool: string;
    args: Record<string, unknown>;
    toolCallId: string | null;
    title: string;
    reason: string;
    fields: {label: string; value: string}[];
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    requestedBy: string | null;
    decidedBy: string | null;
    decidedAt: number | null;
    executedAt: number | null;
    result: string | null;
    createdAt: number;
};

export async function createApproval(db: Db, a: Omit<ApprovalRow, 'id' | 'status' | 'decidedBy' | 'decidedAt' | 'createdAt' | 'postId' | 'executedAt' | 'result'>): Promise<ApprovalRow> {
    const [row] = await db`
        insert into approvals (id, workspace_id, channel_id, run_id, step_id, agent_id, tool, args, tool_call_id, title, reason, fields, status, requested_by, created_at)
        values (${newId()}, ${a.workspaceId}, ${a.channelId}, ${a.runId}, ${a.stepId}, ${a.agentId}, ${a.tool}, ${db.json(a.args as never)}, ${a.toolCallId},
                ${a.title}, ${a.reason}, ${db.json(a.fields as never)}, 'pending', ${a.requestedBy}, ${now()})
        returning *`;
    return row as unknown as ApprovalRow;
}

export async function getApproval(db: Db, id: string): Promise<ApprovalRow | null> {
    const [row] = await db`select * from approvals where id = ${id}`;
    return (row as unknown as ApprovalRow) ?? null;
}

export async function setApprovalPost(db: Db, id: string, postId: string): Promise<void> {
    await db`update approvals set post_id = ${postId} where id = ${id}`;
}

// Decide once: returns null when someone else already decided.
export async function decideApproval(db: Db, id: string, status: 'approved' | 'rejected', userId: string): Promise<ApprovalRow | null> {
    const [row] = await db`
        update approvals set status = ${status}, decided_by = ${userId}, decided_at = ${now()}
        where id = ${id} and status = 'pending'
        returning *`;
    return (row as unknown as ApprovalRow) ?? null;
}

// The approved action runs once: whoever claims it first runs it.
export async function claimApprovalExecution(db: Db, id: string): Promise<boolean> {
    const r = await db`update approvals set executed_at = ${now()} where id = ${id} and status = 'approved' and executed_at is null`;
    return r.count === 1;
}

export async function setApprovalResult(db: Db, id: string, result: string): Promise<void> {
    await db`update approvals set result = ${result.slice(0, 20_000)} where id = ${id}`;
}

export async function listPendingApprovals(db: Db, workspaceId: string, userId: string): Promise<ApprovalRow[]> {
    return (await db`
        select a.* from approvals a
        join channel_members m on m.channel_id = a.channel_id and m.user_id = ${userId}
        where a.workspace_id = ${workspaceId} and a.status = 'pending'
        order by a.created_at desc`) as unknown as ApprovalRow[];
}
