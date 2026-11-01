// Settings → Connections → MCP servers: Granola, Notion and Linear in one
// click, or any remote MCP server by its address (with a token, or a
// sign-in the server asks for). Each person connects their own, in each
// workspace; agents working for them use them (connectors/mcp/tools.ts).

import {z} from 'zod';

import {McpError, checkMcpUrl, displayUrl} from '../connectors/mcp/net.js';
import {MCP_PRESETS, presetFor} from '../connectors/mcp/presets.js';
import {finishSignIn, startSignIn, verify} from '../connectors/mcp/service.js';
import {readsOnly} from '../connectors/mcp/tools.js';
import type {McpConnections, McpServerInfo} from '../shared/types.js';
import {audit} from '../store/audit.js';
import {deleteMcp, getMcp, insertMcp, listMcp, type McpRow, updateMcp} from '../store/mcp.js';
import type {UserRow} from '../store/users.js';
import {encryptSecret} from '../util/crypto.js';
import {badRequest, notFound} from '../util/errors.js';

import type {Ctx} from './context.js';
import {requireWorkspaceRole} from './permissions.js';

const MAX_SERVERS = 10;
const RESERVED_HEADERS = new Set(['authorization', 'host', 'content-type', 'content-length', 'accept', 'accept-encoding', 'cookie', 'connection', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'expect', 'proxy-authorization', 'mcp-session-id', 'mcp-protocol-version']);

export function serverInfo(r: McpRow): McpServerInfo {
    return {
        id: r.id, preset: r.preset, name: r.name, url: displayUrl(r.url), status: r.status, lastError: r.lastError, authMode: r.authMode,
        tools: r.tools.map((t) => ({name: t.name, reads: readsOnly(t)})), enabled: r.enabled, verifiedAt: r.verifiedAt,
    };
}

export async function listServers(ctx: Ctx, user: UserRow, workspaceId: string): Promise<McpConnections> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'member');
    const rows = await listMcp(ctx.sql, workspaceId, user.id);
    return {presets: MCP_PRESETS.map((p) => ({id: p.id, name: p.name, description: p.description})), servers: rows.map(serverInfo)};
}

const addInput = z.object({
    preset: z.string().max(40).optional(),
    name: z.string().trim().max(100).optional(),
    url: z.string().trim().max(2048).optional(),
    token: z.string().trim().max(8192).optional().nullable(),
    authHeader: z.string().trim().max(64).regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, 'A header name is letters, digits and dashes.').optional().nullable(),
});

function friendly(e: unknown): never {
    if (e instanceof McpError) {
        throw badRequest(e.message, 'mcp_error');
    }
    throw e;
}

async function mine(ctx: Ctx, user: UserRow, workspaceId: string, id: string): Promise<McpRow> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'member');
    const row = await getMcp(ctx.sql, id);
    if (!row || row.workspaceId !== workspaceId || row.userId !== user.id) {
        throw notFound('That connection');
    }
    return row;
}

// Add a server and check it. If it wants a sign-in, the answer carries the
// page to open.
export async function addServer(ctx: Ctx, user: UserRow, workspaceId: string, body: unknown): Promise<{server: McpServerInfo; signInUrl: string | null}> {
    await requireWorkspaceRole(ctx.sql, workspaceId, user.id, 'member');
    const input = addInput.parse(body);
    const preset = input.preset ? MCP_PRESETS.find((p) => p.id === input.preset) : undefined;
    if (input.preset && !preset) {
        throw notFound('That server');
    }
    const url = preset?.url ?? input.url ?? '';
    try {
        checkMcpUrl(url);
    } catch (e) {
        friendly(e);
    }
    if (input.authHeader && (RESERVED_HEADERS.has(input.authHeader.toLowerCase()) || !input.token)) {
        throw badRequest(input.token ? 'That header name is reserved. Leave it empty to send the token as a Bearer token.' : 'Add the token that goes in that header.');
    }
    const existing = await listMcp(ctx.sql, workspaceId, user.id);
    let row = existing.find((r) => r.url === url);
    if (!row) {
        if (existing.length >= MAX_SERVERS) {
            throw badRequest(`You can connect up to ${MAX_SERVERS} MCP servers in a workspace.`);
        }
        const known = preset ?? presetFor(url);
        row = await insertMcp(ctx.sql, {
            workspaceId, userId: user.id, preset: known?.id ?? null,
            name: input.name || known?.name || new URL(url).hostname.replace(/^(mcp|api|www)\./, ''),
            url, authMode: input.token ? 'token' : 'none', authHeader: input.token ? input.authHeader ?? null : null,
            token: input.token ? encryptSecret(input.token) : null,
        });
        audit(ctx.sql, {workspaceId, userId: user.id, action: 'mcp_connected', target: row.id, meta: {url: displayUrl(url)}});
    } else if (input.token) {
        row = await updateMcp(ctx.sql, row.id, {authMode: 'token', token: encryptSecret(input.token), refreshToken: null});
    }
    row = await verify(ctx, row);
    let signInUrl: string | null = null;
    if (row.status === 'needs_sign_in') {
        try {
            signInUrl = await startSignIn(ctx, row);
            row = (await getMcp(ctx.sql, row.id))!;
        } catch (e) {
            row = await updateMcp(ctx.sql, row.id, {status: 'error', lastError: e instanceof McpError ? e.message : 'Couldn\'t start the sign-in.'});
        }
    }
    return {server: serverInfo(row), signInUrl};
}

export async function signIn(ctx: Ctx, user: UserRow, workspaceId: string, id: string): Promise<{url: string}> {
    const row = await mine(ctx, user, workspaceId, id);
    try {
        return {url: await startSignIn(ctx, row)};
    } catch (e) {
        return friendly(e);
    }
}

export async function recheck(ctx: Ctx, user: UserRow, workspaceId: string, id: string): Promise<McpServerInfo> {
    return serverInfo(await verify(ctx, await mine(ctx, user, workspaceId, id)));
}

export async function setEnabled(ctx: Ctx, user: UserRow, workspaceId: string, id: string, body: unknown): Promise<McpServerInfo> {
    const {enabled} = z.object({enabled: z.boolean()}).parse(body);
    const row = await mine(ctx, user, workspaceId, id);
    return serverInfo(await updateMcp(ctx.sql, row.id, {enabled}));
}

export async function removeServer(ctx: Ctx, user: UserRow, workspaceId: string, id: string): Promise<void> {
    const row = await mine(ctx, user, workspaceId, id);
    await deleteMcp(ctx.sql, row.id);
    audit(ctx.sql, {workspaceId, userId: user.id, action: 'mcp_disconnected', target: row.id});
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Where a server's sign-in sends the browser back.
export async function callbackPage(ctx: Ctx, query: Record<string, unknown>): Promise<string> {
    const r = await finishSignIn(ctx, query);
    const name = esc(r.name.slice(0, 60));
    const title = r.ok ? `${name} is connected` : `${name} didn't connect`;
    const line = r.ok ? 'You can close this tab and go back to Captain. Agents working for you can use it now.' : esc(r.reason ?? 'Try again from Captain → Settings → Connections.');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f5f7fb;color:#1b2540}
main{max-width:440px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#56627a}
@media (prefers-color-scheme:dark){body{background:#12161f;color:#e8ecf5}p{color:#a3adc2}}</style></head>
<body><main><h1>${title}</h1><p>${line}</p></main></body></html>`;
}
