// Accounts: sign up, sign in, sign out, your profile, other people's profiles.

import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

import {changePassword, issueSession, login, logout, me, nameSchema, signupUser} from '../app/auth.js';
import {requestByEmail, useResetLink} from '../app/passwords.js';
import {acceptInvite, createWorkspaceFor, previewInvite} from '../app/workspaces.js';
import {mailEnabled} from '../util/mail.js';
import {config} from '../config.js';
import {tx} from '../db/index.js';
import {getInviteByHash, inviteUsable} from '../store/workspaces.js';
import {getUsers, toUser, updateUser} from '../store/users.js';
import {sha256} from '../util/crypto.js';
import {forbidden} from '../util/errors.js';

import type {Api} from '../server.js';

const signupInput = z.object({
    email: z.string(),
    password: z.string(),
    name: z.string(),
    invite: z.string().max(200).optional(),
    workspaceName: z.string().max(60).optional(),
});

export function authRoutes(app: FastifyInstance, api: Api): void {
    const {ctx} = api;
    const meta = (req: {headers: Record<string, unknown>; ip: string}) => ({userAgent: String(req.headers['user-agent'] ?? ''), ip: req.ip});

    app.get('/config', {config: {public: true}}, async () => ({
        openSignup: config.openSignup,
        emailEnabled: mailEnabled(),
        demoMode: ctx.router.demoMode,
        version: api.version,
    }));

    app.post('/auth/signup', {config: {public: true, auth: true}}, async (req) => {
        const body = signupInput.parse(req.body);
        if (!config.openSignup) {
            const invite = body.invite ? await getInviteByHash(ctx.sql, sha256(body.invite)) : null;
            if (!invite || !inviteUsable(invite)) {
                throw forbidden('This server is invite-only. Ask for an invite link.');
            }
        }
        const user = await tx(ctx.sql, (t) => signupUser(t, body));
        if (body.invite) {
            await acceptInvite(ctx, user, body.invite);
        } else if (body.workspaceName?.trim()) {
            await createWorkspaceFor(ctx, user, body.workspaceName);
        }
        return issueSession(ctx.sql, user, meta(req));
    });

    app.post('/auth/login', {config: {public: true, auth: true}}, async (req) => {
        const body = z.object({login: z.string(), password: z.string()}).parse(req.body);
        return login(ctx.sql, body, meta(req));
    });

    // Forgot password: always the same answer, whether or not the address has an account.
    app.post('/auth/password-reset', {config: {public: true, auth: true}}, async (req) => {
        await requestByEmail(ctx, (req.body as {email?: unknown})?.email, {ip: req.ip});
        return {ok: true};
    });

    app.post('/auth/password-reset/confirm', {config: {public: true, auth: true}}, async (req) => useResetLink(ctx, req.body, meta(req)));

    app.post('/auth/logout', async (req) => {
        await logout(ctx.sql, req.token, req.sessionId);
        ctx.hub.closeSessions([req.sessionId]);
        return {ok: true};
    });

    app.get('/users/me', async (req) => me(req.user));

    app.patch('/users/me', async (req) => {
        const body = z.object({displayName: nameSchema.optional()}).parse(req.body);
        const user = await updateUser(ctx.sql, req.user.id, {displayName: body.displayName});
        const peers = await ctx.sql`select distinct m2.user_id from workspace_members m1 join workspace_members m2 on m2.workspace_id = m1.workspace_id where m1.user_id = ${user.id}`;
        ctx.hub.publish(peers.map((r) => r.userId as string), {event: 'user_updated', data: {user: toUser(user)}});
        return me(user);
    });

    app.post('/users/me/password', {config: {auth: true}}, async (req) => {
        const body = z.object({current: z.string(), next: z.string()}).parse(req.body);
        await changePassword(ctx.sql, req.user, req.sessionId, body.current, body.next);
        ctx.hub.closeUserSessions(req.user.id, req.sessionId);
        return {ok: true};
    });

    // Profiles of people you share a workspace with.
    app.get('/users', async (req) => {
        const ids = String((req.query as {ids?: string}).ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
        if (!ids.length) {
            return [];
        }
        const visible = await ctx.sql`
            select distinct m2.user_id from workspace_members m1
            join workspace_members m2 on m2.workspace_id = m1.workspace_id
            where m1.user_id = ${req.user.id} and m2.user_id = any(${ids})`;
        const users = await getUsers(ctx.sql, visible.map((r) => r.userId as string));
        return users.map((u) => toUser(u, {includeEmail: u.id === req.user.id}));
    });

    app.get('/invites/:token', {config: {public: true}}, async (req) => previewInvite(ctx, (req.params as {token: string}).token));

    app.post('/invites/:token/accept', async (req) => acceptInvite(ctx, req.user, (req.params as {token: string}).token));
}
