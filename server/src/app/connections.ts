// Settings → Connections: your Google apps (through Composio), connected one
// by one for this workspace, and (for the people who run the server) the
// Composio key that makes them possible. See connectors/composio.ts.

import {z} from 'zod';

import {ComposioError, composioUserId, GOOGLE_APPS} from '../connectors/composio.js';
import {config} from '../config.js';
import type {ConnectionApp, Connections} from '../shared/types.js';
import {audit} from '../store/audit.js';
import {isInstanceAdmin, type UserRow} from '../store/users.js';
import {badRequest, notFound} from '../util/errors.js';

import {requireInstanceAdmin} from './admin.js';
import type {Ctx} from './context.js';
import {requireWorkspaceRole} from './permissions.js';

const STATUS: Record<string, ConnectionApp['status']> = {ACTIVE: 'connected', INITIATED: 'pending', INITIALIZING: 'pending', EXPIRED: 'expired', FAILED: 'expired', INACTIVE: 'expired'};

function friendly(e: unknown): never {
    if (e instanceof ComposioError) {
        throw badRequest(e.message, 'connector_error');
    }
    throw e;
}

export async function listConnections(ctx: Ctx, user: UserRow, workspaceId: string): Promise<Connections> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'member');
    const admin = isInstanceAdmin(user);
    const stored = ctx.keys.info('composio');
    const source = ctx.composio.keySource();
    const key = admin ? {source, last4: source === 'settings' ? stored?.last4 ?? null : source === 'environment' ? config.connectors.composioKey.slice(-4) : null} : null;
    const base = (status: ConnectionApp['status']): ConnectionApp[] => GOOGLE_APPS.map((a) => ({toolkit: a.toolkit, name: a.name, status, writes: a.write.length > 0}));
    if (!ctx.composio.configured()) {
        return {configured: false, canSetUp: admin, key, apps: base('not_connected'), error: null};
    }
    try {
        const mine = await ctx.composio.connections(composioUserId(user.id, workspaceId));
        const best = (toolkit: string): ConnectionApp['status'] => {
            const statuses = mine.filter((c) => c.toolkit === toolkit).map((c) => STATUS[c.status] ?? 'expired');
            return statuses.includes('connected') ? 'connected' : statuses.includes('pending') ? 'pending' : statuses.includes('expired') ? 'expired' : 'not_connected';
        };
        return {configured: true, canSetUp: admin, key, apps: base('not_connected').map((a) => ({...a, status: best(a.toolkit)})), error: null};
    } catch (e) {
        return {configured: true, canSetUp: admin, key, apps: base('not_connected'), error: e instanceof ComposioError ? e.message : 'Couldn\'t reach Composio.'};
    }
}

function app(toolkit: string) {
    const a = GOOGLE_APPS.find((x) => x.toolkit === toolkit);
    if (!a) {
        throw notFound('That app');
    }
    return a;
}

// Composio's sign-in page for one app; it comes back to /connections/done.
export async function connect(ctx: Ctx, user: UserRow, workspaceId: string, toolkit: string): Promise<{url: string}> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'member');
    const a = app(toolkit);
    try {
        const url = await ctx.composio.link(a.toolkit, composioUserId(user.id, workspaceId), `${config.publicUrl}/connections/done?app=${encodeURIComponent(a.name)}`);
        return {url};
    } catch (e) {
        return friendly(e);
    }
}

export async function disconnect(ctx: Ctx, user: UserRow, workspaceId: string, toolkit: string): Promise<void> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'member');
    const a = app(toolkit);
    try {
        const mine = (await ctx.composio.connections(composioUserId(user.id, workspaceId))).filter((c) => c.toolkit === a.toolkit);
        for (const c of mine) {
            await ctx.composio.disconnect(c.id);
        }
    } catch (e) {
        friendly(e);
    }
}

const keyInput = z.object({apiKey: z.string().trim().min(8, 'That key looks too short.').max(500).regex(/^\S+$/, 'A key has no spaces in it.')});

export async function saveComposioKey(ctx: Ctx, user: UserRow, body: unknown, ip?: string): Promise<void> {
    requireInstanceAdmin(user);
    const {apiKey} = keyInput.parse(body);
    try {
        await ctx.composio.check(apiKey);
    } catch (e) {
        if (e instanceof ComposioError) {
            throw badRequest(`Composio didn't accept that key (${e.message}). It wasn't saved.`, 'key_rejected');
        }
        throw e;
    }
    await ctx.keys.set('composio', apiKey, null, user.id);
    ctx.composio.forget();
    audit(ctx.sql, {userId: user.id, action: 'connector_key_saved', target: 'composio', ip});
}

export async function removeComposioKey(ctx: Ctx, user: UserRow, ip?: string): Promise<void> {
    requireInstanceAdmin(user);
    await ctx.keys.remove('composio');
    ctx.composio.forget();
    audit(ctx.sql, {userId: user.id, action: 'connector_key_removed', target: 'composio', ip});
}

// Where Composio's sign-in sends the browser afterwards.
export function donePage(query: Record<string, unknown>): string {
    const name = String(query.app ?? 'Google').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 40) || 'Google';
    const ok = !query.status || String(query.status).toLowerCase() === 'success';
    const title = ok ? `${name} is connected` : `${name} didn't connect`;
    const line = ok ? 'You can close this tab and go back to Captain. Agents can use it now.' : 'Close this tab and try Connect again in Captain → Settings → Connections.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f5f7fb;color:#1b2540}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#56627a}
@media (prefers-color-scheme:dark){body{background:#12161f;color:#e8ecf5}p{color:#a3adc2}}</style></head>
<body><main><h1>${title}</h1><p>${line}</p></main></body></html>`;
}
