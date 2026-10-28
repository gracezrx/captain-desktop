import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

import * as agentsApp from '../app/agents.js';
import * as ws from '../app/workspaces.js';
import {listPendingApprovals} from '../store/runs.js';
import {requireWorkspaceRole} from '../app/permissions.js';

import type {Api} from '../server.js';

type P = {id: string; userId: string; inviteId: string};

const roleSchema = z.enum(['owner', 'admin', 'member', 'guest']);

export function workspaceRoutes(app: FastifyInstance, api: Api): void {
    const {ctx} = api;

    app.get('/workspaces', async (req) => ws.listMyWorkspaces(ctx, req.user));

    app.post('/workspaces', async (req) => {
        const body = z.object({name: z.string()}).parse(req.body);
        return ws.createWorkspaceFor(ctx, req.user, body.name);
    });

    app.patch('/workspaces/:id', async (req) => {
        const body = z.object({name: z.string().optional(), monthlyBudgetUsd: z.number().nullable().optional()}).parse(req.body);
        return ws.renameOrBudget(ctx, req.user, (req.params as P).id, body);
    });

    app.get('/workspaces/:id/members', async (req) => ws.members(ctx, req.user, (req.params as P).id));

    app.patch('/workspaces/:id/members/:userId', async (req) => {
        const {role} = z.object({role: roleSchema}).parse(req.body);
        const p = req.params as P;
        await ws.changeRole(ctx, req.user, p.id, p.userId, role);
        return {ok: true};
    });

    app.delete('/workspaces/:id/members/:userId', async (req) => {
        const p = req.params as P;
        await ws.removeMember(ctx, req.user, p.id, p.userId);
        return {ok: true};
    });

    app.post('/workspaces/:id/invites', async (req) => {
        const body = z.object({
            role: roleSchema.optional(),
            maxUses: z.number().int().min(1).max(10_000).nullable().optional(),
            expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
        }).parse(req.body ?? {});
        return ws.makeInvite(ctx, req.user, (req.params as P).id, body);
    });

    app.get('/workspaces/:id/invites', async (req) => ws.invites(ctx, req.user, (req.params as P).id));

    app.delete('/workspaces/:id/invites/:inviteId', async (req) => {
        const p = req.params as P;
        await ws.cancelInvite(ctx, req.user, p.id, p.inviteId);
        return {ok: true};
    });

    // Agents, models and spend.
    app.get('/workspaces/:id/agents', async (req) => agentsApp.agents(ctx, req.user, (req.params as P).id));
    app.post('/workspaces/:id/agents', async (req) => agentsApp.createAgent(ctx, req.user, (req.params as P).id, req.body));
    app.patch('/agents/:id', async (req) => agentsApp.editAgent(ctx, req.user, (req.params as P).id, req.body));
    app.get('/workspaces/:id/models', async (req) => agentsApp.models(ctx, req.user, (req.params as P).id));
    app.get('/workspaces/:id/usage', async (req) => agentsApp.usage(ctx, req.user, (req.params as P).id));

    // Decisions waiting for you (or anyone, if you're an admin) in channels you're in.
    app.get('/workspaces/:id/approvals', async (req) => {
        const id = (req.params as P).id;
        await requireWorkspaceRole(ctx.sql, id, req.user.id);
        return (await listPendingApprovals(ctx.sql, id, req.user.id)).map((a) => ({
            id: a.id, channelId: a.channelId, postId: a.postId, runId: a.runId, title: a.title, tool: a.tool, requestedBy: a.requestedBy, createdAt: a.createdAt,
        }));
    });

    app.get('/runs/:id', async (req) => agentsApp.runInfo(ctx, req.user, (req.params as P).id));
    app.post('/runs/:id/cancel', async (req) => agentsApp.cancelRun(ctx, api.orchestrator, req.user, (req.params as P).id));
}
