// Workspaces (Mattermost's "teams"), their members, roles and invite links.

import {z} from 'zod';

import {seedBuiltinAgents} from '../agents/builtins.js';
import {config} from '../config.js';
import {tx} from '../db/index.js';
import type {InvitePreview, User, Workspace, WorkspaceMember, WorkspaceRole} from '../shared/types.js';
import {audit} from '../store/audit.js';
import {addChannelMember, createChannel, getChannelByName} from '../store/channels.js';
import {getUsers, toUser, type UserRow} from '../store/users.js';
import {
    addWorkspaceMember, consumeInvite, countOwners, createInvite, createWorkspace, getInviteByHash, getMemberRole, getWorkspace,
    inviteUsable, listInvites, listWorkspaceMembers, listWorkspacesForUser, removeWorkspaceMember, revokeInvite, setMemberRole,
    slugTaken, toWorkspace, updateWorkspace,
} from '../store/workspaces.js';
import {newToken, sha256} from '../util/crypto.js';
import {badRequest, forbidden, notFound} from '../util/errors.js';
import {newId, now} from '../util/ids.js';

import type {Ctx} from './context.js';
import {toWorkspace as publishToWorkspace} from './events.js';
import {atLeast, requireWorkspaceRole} from './permissions.js';

export const workspaceNameSchema = z.string().trim().min(1, 'Name your workspace.').max(60);

async function freeSlug(ctx: Ctx, name: string): Promise<string> {
    const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
    for (let i = 1; i < 500; i++) {
        const slug = i === 1 ? base : `${base}-${i}`;
        if (!(await slugTaken(ctx.sql, slug))) {
            return slug;
        }
    }
    return `${base}-${newId().slice(0, 6)}`;
}

// A new workspace comes with #general and the built-in agents.
export async function createWorkspaceFor(ctx: Ctx, user: UserRow, nameInput: string): Promise<Workspace> {
    const name = workspaceNameSchema.parse(nameInput);
    const slug = await freeSlug(ctx, name);
    const ws = await tx(ctx.sql, async (t) => {
        const w = await createWorkspace(t, {name, slug, createdBy: user.id});
        await addWorkspaceMember(t, w.id, user.id, 'owner');
        const general = await createChannel(t, {workspaceId: w.id, type: 'O', name: 'general', displayName: 'General', purpose: 'Everyone in the workspace, and the agents', createdBy: user.id});
        await addChannelMember(t, general.id, user.id, 'admin');
        await seedBuiltinAgents(t, w.id, [general.id]);
        return w;
    });
    audit(ctx.sql, {workspaceId: ws.id, userId: user.id, action: 'workspace_created'});
    return toWorkspace(ws, 'owner');
}

export async function listMyWorkspaces(ctx: Ctx, user: UserRow): Promise<Workspace[]> {
    return (await listWorkspacesForUser(ctx.sql, user.id)).map((w) => toWorkspace(w, w.role));
}

export async function renameOrBudget(ctx: Ctx, user: UserRow, workspaceId: string, patch: {name?: string; monthlyBudgetUsd?: number | null}): Promise<Workspace> {
    const role = await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'admin');
    if (patch.monthlyBudgetUsd !== undefined && patch.monthlyBudgetUsd !== null && (!Number.isFinite(patch.monthlyBudgetUsd) || patch.monthlyBudgetUsd < 0)) {
        throw badRequest('The budget must be a positive number of dollars.');
    }
    const w = await updateWorkspace(ctx.sql, workspaceId, {name: patch.name !== undefined ? workspaceNameSchema.parse(patch.name) : undefined, monthlyBudgetUsd: patch.monthlyBudgetUsd});
    audit(ctx.sql, {workspaceId, userId: user.id, action: 'workspace_updated', meta: patch});
    return toWorkspace(w, role);
}

export async function members(ctx: Ctx, user: UserRow, workspaceId: string): Promise<{members: WorkspaceMember[]; users: User[]}> {
    const role = await requireWorkspaceRole(ctx.sql, workspaceId, user.id);
    const list = await listWorkspaceMembers(ctx.sql, workspaceId);
    const users = await getUsers(ctx.sql, list.map((m) => m.userId));
    return {members: list, users: users.map((u) => toUser(u, {includeEmail: atLeast(role, 'admin') || u.id === user.id}))};
}

export async function changeRole(ctx: Ctx, actor: UserRow, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    const actorRole = await requireWorkspaceRole(ctx.sql, workspaceId, actor.id, 'admin');
    const current = await getMemberRole(ctx.sql, workspaceId, userId);
    if (!current) {
        throw notFound('Member');
    }
    // Only owners make or unmake owners; there is always at least one owner.
    if ((role === 'owner' || current === 'owner') && actorRole !== 'owner') {
        throw forbidden('Only an owner can change owners.');
    }
    if (current === 'owner' && role !== 'owner' && (await countOwners(ctx.sql, workspaceId)) <= 1) {
        throw badRequest('A workspace needs at least one owner.');
    }
    await setMemberRole(ctx.sql, workspaceId, userId, role);
    audit(ctx.sql, {workspaceId, userId: actor.id, action: 'role_changed', target: userId, meta: {from: current, to: role}});
}

export async function removeMember(ctx: Ctx, actor: UserRow, workspaceId: string, userId: string): Promise<void> {
    const actorRole = actor.id !== userId ? await requireWorkspaceRole(ctx.sql, workspaceId, actor.id, 'admin') : null;
    const current = await getMemberRole(ctx.sql, workspaceId, userId);
    if (!current) {
        throw notFound('Member');
    }
    if (current === 'owner' && actorRole && actorRole !== 'owner') {
        throw forbidden('Only an owner can remove an owner.');
    }
    if (current === 'owner' && (await countOwners(ctx.sql, workspaceId)) <= 1) {
        throw badRequest('The last owner can\'t leave. Make someone else an owner first.');
    }
    await tx(ctx.sql, async (t) => {
        await removeWorkspaceMember(t, workspaceId, userId);
        // Their invite links stop working too, so they can't let themselves back in.
        await t`update invites set revoked_at = ${now()} where workspace_id = ${workspaceId} and created_by = ${userId} and revoked_at is null`;
        await t`delete from channel_members where user_id = ${userId} and channel_id in (select id from channels where workspace_id = ${workspaceId})`;
    });
    audit(ctx.sql, {workspaceId, userId: actor.id, action: 'member_removed', target: userId});
}

// ------------------------------------------------------------ invites

export async function makeInvite(ctx: Ctx, actor: UserRow, workspaceId: string, input: {role?: WorkspaceRole; maxUses?: number | null; expiresInDays?: number | null}): Promise<{url: string; token: string; id: string}> {
    const actorRole = await requireWorkspaceRole(ctx.sql, workspaceId, actor.id, 'member');
    const role = input.role ?? 'member';
    if (role === 'owner') {
        throw badRequest('Invite as an admin, member or guest; promote to owner afterwards.');
    }
    if (role === 'admin' && !atLeast(actorRole, 'admin')) {
        throw forbidden('Only admins can invite admins.');
    }
    const token = newToken(18);
    // Only admins can make links that never expire; others last at most 30 days.
    const asked = input.expiresInDays === null ? null : input.expiresInDays ?? 14;
    const days = atLeast(actorRole, 'admin') ? asked : Math.min(asked ?? 14, 30);
    const invite = await createInvite(ctx.sql, {
        workspaceId, tokenHash: sha256(token), role, createdBy: actor.id,
        expiresAt: days === null ? null : now() + days * 86_400_000,
        maxUses: input.maxUses === undefined ? null : input.maxUses,
    });
    audit(ctx.sql, {workspaceId, userId: actor.id, action: 'invite_created', meta: {role, days}});
    return {id: invite.id, token, url: `${config.publicUrl}/?invite=${token}`};
}

export async function invites(ctx: Ctx, actor: UserRow, workspaceId: string) {
    await requireWorkspaceRole(ctx.sql, workspaceId, actor.id, 'admin');
    return (await listInvites(ctx.sql, workspaceId)).map((i) => ({id: i.id, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, maxUses: i.maxUses, uses: i.uses}));
}

export async function cancelInvite(ctx: Ctx, actor: UserRow, workspaceId: string, inviteId: string): Promise<void> {
    await requireWorkspaceRole(ctx.sql, workspaceId, actor.id, 'admin');
    await revokeInvite(ctx.sql, workspaceId, inviteId);
}

export async function previewInvite(ctx: Ctx, token: string): Promise<InvitePreview> {
    const invite = await getInviteByHash(ctx.sql, sha256(token));
    const ws = invite ? await getWorkspace(ctx.sql, invite.workspaceId) : null;
    if (!invite || !ws) {
        return {workspaceName: '', role: 'member', valid: false};
    }
    return {workspaceName: ws.name, role: invite.role, valid: inviteUsable(invite)};
}

// Join a workspace with an invite; members (not guests) also join #general.
export async function acceptInvite(ctx: Ctx, user: UserRow, token: string): Promise<Workspace> {
    const invite = await getInviteByHash(ctx.sql, sha256(token));
    if (!invite || !inviteUsable(invite)) {
        throw badRequest('This invite link has expired or been used up. Ask for a new one.', 'invite_invalid');
    }
    // The person who made the link must still be allowed to invite with it.
    const creatorRole = await getMemberRole(ctx.sql, invite.workspaceId, invite.createdBy);
    if (!creatorRole || creatorRole === 'guest' || (invite.role === 'admin' && !atLeast(creatorRole, 'admin'))) {
        throw badRequest('This invite link has expired or been used up. Ask for a new one.', 'invite_invalid');
    }
    const existing = await getMemberRole(ctx.sql, invite.workspaceId, user.id);
    const ws = await getWorkspace(ctx.sql, invite.workspaceId);
    if (!ws) {
        throw notFound('Workspace');
    }
    if (existing) {
        return toWorkspace(ws, existing);
    }
    await tx(ctx.sql, async (t) => {
        if (!(await consumeInvite(t, invite.id))) {
            throw badRequest('This invite link has expired or been used up. Ask for a new one.', 'invite_invalid');
        }
        await addWorkspaceMember(t, invite.workspaceId, user.id, invite.role);
        if (invite.role !== 'guest') {
            const general = await getChannelByName(t, invite.workspaceId, 'general');
            if (general) {
                await addChannelMember(t, general.id, user.id);
            }
        }
    });
    audit(ctx.sql, {workspaceId: ws.id, userId: user.id, action: 'invite_accepted', meta: {role: invite.role}});
    await publishToWorkspace(ctx, ctx.sql, ws.id, {event: 'workspace_member_added', data: {workspaceId: ws.id, user: toUser(user), role: invite.role}});
    return toWorkspace(ws, invite.role);
}
