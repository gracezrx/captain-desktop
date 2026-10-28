import type {Db} from '../db/index.js';
import type {Workspace, WorkspaceMember, WorkspaceRole} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type WorkspaceRow = {
    id: string;
    name: string;
    slug: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    monthlyBudgetUsd: number | null;
    settings: Record<string, unknown>;
};

export function toWorkspace(r: WorkspaceRow, role: WorkspaceRole): Workspace {
    return {id: r.id, name: r.name, slug: r.slug, createdAt: r.createdAt, role, monthlyBudgetUsd: r.monthlyBudgetUsd};
}

export async function createWorkspace(db: Db, w: {name: string; slug: string; createdBy: string; monthlyBudgetUsd?: number | null}): Promise<WorkspaceRow> {
    const t = now();
    const [row] = await db`
        insert into workspaces (id, name, slug, created_by, created_at, updated_at, monthly_budget_usd)
        values (${newId()}, ${w.name}, ${w.slug}, ${w.createdBy}, ${t}, ${t}, ${w.monthlyBudgetUsd ?? null})
        returning *`;
    return row as unknown as WorkspaceRow;
}

export async function getWorkspace(db: Db, id: string): Promise<WorkspaceRow | null> {
    const [row] = await db`select * from workspaces where id = ${id} and deleted_at is null`;
    return (row as unknown as WorkspaceRow) ?? null;
}

export async function slugTaken(db: Db, slug: string): Promise<boolean> {
    const [row] = await db`select 1 from workspaces where slug = ${slug}`;
    return Boolean(row);
}

export async function updateWorkspace(db: Db, id: string, patch: {name?: string; monthlyBudgetUsd?: number | null; settings?: Record<string, unknown>}): Promise<WorkspaceRow> {
    const [row] = await db`
        update workspaces set
            name = coalesce(${patch.name ?? null}, name),
            monthly_budget_usd = case when ${patch.monthlyBudgetUsd !== undefined} then ${patch.monthlyBudgetUsd ?? null}::double precision else monthly_budget_usd end,
            settings = case when ${patch.settings !== undefined} then ${db.json((patch.settings ?? {}) as never)} else settings end,
            updated_at = ${now()}
        where id = ${id}
        returning *`;
    return row as unknown as WorkspaceRow;
}

export async function listWorkspacesForUser(db: Db, userId: string): Promise<(WorkspaceRow & {role: WorkspaceRole})[]> {
    return (await db`
        select w.*, m.role from workspaces w
        join workspace_members m on m.workspace_id = w.id
        where m.user_id = ${userId} and w.deleted_at is null
        order by m.joined_at`) as unknown as (WorkspaceRow & {role: WorkspaceRole})[];
}

export async function addWorkspaceMember(db: Db, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await db`
        insert into workspace_members (workspace_id, user_id, role, joined_at)
        values (${workspaceId}, ${userId}, ${role}, ${now()})
        on conflict (workspace_id, user_id) do nothing`;
}

export async function getMemberRole(db: Db, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const [row] = await db`select role from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
    return (row?.role as WorkspaceRole) ?? null;
}

export async function listWorkspaceMembers(db: Db, workspaceId: string): Promise<WorkspaceMember[]> {
    return (await db`select user_id, role, joined_at from workspace_members where workspace_id = ${workspaceId} order by joined_at`) as unknown as WorkspaceMember[];
}

export async function setMemberRole(db: Db, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await db`update workspace_members set role = ${role} where workspace_id = ${workspaceId} and user_id = ${userId}`;
}

export async function removeWorkspaceMember(db: Db, workspaceId: string, userId: string): Promise<void> {
    await db`delete from channel_members where user_id = ${userId} and channel_id in (select id from channels where workspace_id = ${workspaceId})`;
    await db`delete from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
}

export async function countOwners(db: Db, workspaceId: string): Promise<number> {
    const [row] = await db`select count(*)::int as n from workspace_members where workspace_id = ${workspaceId} and role = 'owner'`;
    return Number(row.n);
}

// ------------------------------------------------------------ invites

export type InviteRow = {
    id: string;
    workspaceId: string;
    tokenHash: string;
    role: WorkspaceRole;
    createdBy: string;
    createdAt: number;
    expiresAt: number | null;
    maxUses: number | null;
    uses: number;
    revokedAt: number | null;
};

export async function createInvite(db: Db, i: {workspaceId: string; tokenHash: string; role: WorkspaceRole; createdBy: string; expiresAt: number | null; maxUses: number | null}): Promise<InviteRow> {
    const [row] = await db`
        insert into invites (id, workspace_id, token_hash, role, created_by, created_at, expires_at, max_uses)
        values (${newId()}, ${i.workspaceId}, ${i.tokenHash}, ${i.role}, ${i.createdBy}, ${now()}, ${i.expiresAt}, ${i.maxUses})
        returning *`;
    return row as unknown as InviteRow;
}

export async function getInviteByHash(db: Db, tokenHash: string): Promise<InviteRow | null> {
    const [row] = await db`select * from invites where token_hash = ${tokenHash}`;
    return (row as unknown as InviteRow) ?? null;
}

export function inviteUsable(i: InviteRow): boolean {
    return !i.revokedAt && (i.expiresAt === null || i.expiresAt > now()) && (i.maxUses === null || i.uses < i.maxUses);
}

// Count a use, but only while the invite is still usable (safe under races).
export async function consumeInvite(db: Db, id: string): Promise<boolean> {
    const r = await db`
        update invites set uses = uses + 1
        where id = ${id} and revoked_at is null and (expires_at is null or expires_at > ${now()}) and (max_uses is null or uses < max_uses)`;
    return r.count === 1;
}

export async function listInvites(db: Db, workspaceId: string): Promise<InviteRow[]> {
    return (await db`select * from invites where workspace_id = ${workspaceId} and revoked_at is null order by created_at desc`) as unknown as InviteRow[];
}

export async function revokeInvite(db: Db, workspaceId: string, id: string): Promise<void> {
    await db`update invites set revoked_at = ${now()} where id = ${id} and workspace_id = ${workspaceId}`;
}
