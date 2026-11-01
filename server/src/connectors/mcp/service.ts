// Using a connected MCP server: its token (refreshed when it's about to run
// out, and once more if the server says no), checking it and reading its
// tools, and starting and finishing a sign-in.

import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

import type {Ctx} from '../../app/context.js';
import {config} from '../../config.js';
import {tx} from '../../db/index.js';
import {byTicket, claimTicket, getMcp, type McpOAuthState, type McpRow, takePending, updateMcp} from '../../store/mcp.js';
import {decryptSecret, encryptSecret} from '../../util/crypto.js';
import {log} from '../../util/log.js';

import {McpClient} from './client.js';
import {McpError} from './net.js';
import {authorizeUrl, discover, exchangeCode, type OAuthClient, pkce, refresh, register, resourceMetadataHint} from './oauth.js';

const SIGN_IN_MINUTES = 10;
const DISCOVERY_TTL_MS = 600_000;

export const callbackUrl = () => `${config.publicUrl}/mcp/oauth/callback`;

function clientOf(o: McpOAuthState): OAuthClient | null {
    if (!o.client) {
        return null;
    }
    return {...o.client, clientSecret: o.client.clientSecret ? decryptSecret(o.client.clientSecret) : null};
}

// The token to call the server with, refreshed first if it's about to
// expire (or the server just said no). One refresh at a time per
// connection, across servers: many sign-in servers hand out a new refresh
// token each time and refuse the old one, so a second refresh racing the
// first would sign the person out.
async function tokenFor(ctx: Ctx, row: McpRow, force = false): Promise<{row: McpRow; token: string | null}> {
    const plain = (r: McpRow) => ({row: r, token: r.token ? decryptSecret(r.token) : null});
    if (row.authMode !== 'oauth') {
        return plain(row);
    }
    const expiring = row.oauth.expiresAt ? row.oauth.expiresAt - Date.now() < 60_000 : false;
    if (!(force || expiring) || !row.refreshToken || !row.oauth.meta) {
        return plain(row);
    }
    const outcome = await tx(ctx.sql, async (t) => {
        await t`select pg_advisory_xact_lock(hashtext(${`mcp-refresh:${row.id}`}))`;
        const current = await getMcp(t, row.id);
        if (!current) {
            throw new McpError('This connection was removed.');
        }
        if (current.token !== row.token) {
            return {kind: 'ok' as const, ...plain(current)}; // refreshed meanwhile
        }
        const client = clientOf(current.oauth);
        const old = current.refreshToken ? decryptSecret(current.refreshToken) : null;
        if (!client || !old || !current.oauth.meta) {
            return {kind: 'ok' as const, ...plain(current)};
        }
        try {
            const fresh = await refresh(current.oauth.meta, client, old);
            const saved = await updateMcp(t, current.id, {
                token: encryptSecret(fresh.accessToken), refreshToken: fresh.refreshToken ? encryptSecret(fresh.refreshToken) : current.refreshToken,
                oauth: {...current.oauth, expiresAt: fresh.expiresAt},
            });
            return {kind: 'ok' as const, row: saved, token: fresh.accessToken};
        } catch (err) {
            const status = err instanceof McpError ? err.status : 0;
            log.warn({err: (err as Error).message, status, server: current.name}, 'MCP token refresh failed');
            // Only a refusal signs the person out; a timeout or an outage doesn't.
            return {kind: status === 400 || status === 401 ? 'signed_out' as const : 'unavailable' as const, row: current, token: null};
        }
    });
    if (outcome.kind === 'signed_out') {
        await updateMcp(ctx.sql, row.id, {status: 'needs_sign_in', lastError: 'Sign-in expired. Sign in again.'});
        throw new McpError(`${row.name} needs you to sign in again.`, 401);
    }
    if (outcome.kind === 'unavailable') {
        throw new McpError(`${row.name}'s sign-in server isn't answering right now. Try again in a minute.`);
    }
    return {row: outcome.row, token: outcome.token};
}

// Run something against the server: handshake first, and on a 401 refresh
// the sign-in once and try again.
export async function withServer<T>(ctx: Ctx, row: McpRow, fn: (c: McpClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let current = await tokenFor(ctx, row);
    for (let attempt = 0; ; attempt++) {
        const client = new McpClient(row.url, current.token ? {token: current.token, header: row.authHeader} : null, signal);
        try {
            await client.initialize();
            return await fn(client);
        } catch (e) {
            if (e instanceof McpError && e.status === 401 && attempt === 0 && current.row.authMode === 'oauth' && current.row.refreshToken) {
                current = await tokenFor(ctx, current.row, true);
                continue;
            }
            throw e;
        }
    }
}

// Check the connection and read its tools. A server that wants a sign-in
// is set up for one (its sign-in found and Captain registered with it).
export async function verify(ctx: Ctx, row: McpRow): Promise<McpRow> {
    try {
        const tools = await withServer(ctx, row, (c) => c.listTools());
        return await updateMcp(ctx.sql, row.id, {status: 'connected', lastError: null, tools, verifiedAt: Date.now()});
    } catch (e) {
        const err = e instanceof McpError ? e : new McpError('Captain couldn\'t check this server.');
        if (err.status === 401 && (row.authMode === 'oauth' || !row.token)) {
            try {
                const known = row.oauth.meta && Date.now() - row.oauth.meta.discoveredAt < DISCOVERY_TTL_MS ? row.oauth.meta : null;
                const fresh = known ?? await discover(row.url, resourceMetadataHint(err.wwwAuthenticate));
                return await updateMcp(ctx.sql, row.id, {authMode: 'oauth', status: 'needs_sign_in', lastError: null, oauth: {...row.oauth, meta: fresh}});
            } catch (d) {
                return await updateMcp(ctx.sql, row.id, {status: 'error', lastError: d instanceof McpError ? d.message : 'Couldn\'t find how to sign in to this server.'});
            }
        }
        const lastError = err.status === 401 ? (row.authMode === 'oauth' ? 'Sign-in expired. Sign in again.' : 'The server turned down the token.') : err.message;
        return await updateMcp(ctx.sql, row.id, {status: err.status === 401 && row.authMode === 'oauth' ? 'needs_sign_in' : 'error', lastError});
    }
}

// --- Sign-in ------------------------------------------------------------------

function stateKey(): Buffer {
    return createHmac('sha256', `captain:mcp-oauth:${config.appSecret}`).update('state').digest();
}

function signState(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
}

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function readState(state: string): {c: string; u: string; n: string; e: number} | null {
    const [body, sig] = state.split('.');
    if (!body || !sig) {
        return null;
    }
    const want = Buffer.from(createHmac('sha256', stateKey()).update(body).digest('base64url'));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
        return null;
    }
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return typeof p.c === 'string' && typeof p.u === 'string' && typeof p.n === 'string' && typeof p.e === 'number' && p.e > Date.now() ? p : null;
    } catch {
        return null;
    }
}

const hash = (v: string) => createHash('sha256').update(v).digest('base64url');

export const startUrl = (ticket: string) => `${config.publicUrl}/mcp/oauth/start?t=${encodeURIComponent(ticket)}`;
export const browserCookie = (connectionId: string) => `captain_mcp_${connectionId}`;

// Begin a sign-in: the page to open is Captain's own start page (good once,
// for ten minutes). It shows which Captain account this connects, then
// gives the browser a cookie and sends it to the server's sign-in; the
// sign-in only finishes in a browser with that cookie. So a sign-in link
// someone else started can't quietly attach your account to theirs.
export async function startSignIn(ctx: Ctx, row: McpRow): Promise<string> {
    let o = row.oauth;
    if (!o.meta || Date.now() - o.meta.discoveredAt > DISCOVERY_TTL_MS) {
        o = {...o, meta: await discover(row.url, null)};
    }
    const meta = o.meta!;
    const redirectUri = callbackUrl();
    // Register again if anything about the sign-in changed (and drop the old grant).
    let token = row.token;
    let refreshToken = row.refreshToken;
    if (!o.client || o.client.redirectUri !== redirectUri || o.client.issuer !== meta.issuer) {
        const c = await register(meta, redirectUri);
        o = {...o, client: {clientId: c.clientId, clientSecret: c.clientSecret ? encryptSecret(c.clientSecret) : null, redirectUri, issuer: c.issuer}, expiresAt: null};
        token = null;
        refreshToken = null;
    }
    const {verifier, challenge} = pkce();
    const nonce = randomBytes(24).toString('base64url');
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + SIGN_IN_MINUTES * 60_000;
    const state = signState({c: row.id, u: row.userId, n: nonce, e: expiresAt});
    const authorize = authorizeUrl(meta, clientOf(o)!, state, challenge);
    o = {...o, pending: {nonce, verifier: encryptSecret(verifier), expiresAt, ticket: hash(ticket), browser: null, authorize}};
    await updateMcp(ctx.sql, row.id, {authMode: 'oauth', oauth: o, token, refreshToken});
    return startUrl(ticket);
}

export type StartPage = {kind: 'confirm'; row: McpRow} | {kind: 'go'; row: McpRow; cookie: string; location: string} | {kind: 'gone'};

// Captain's start page: first a look at which account this is for, then
// (with go) the cookie and the way on to the sign-in server.
export async function openStart(ctx: Ctx, ticket: string, go: boolean): Promise<StartPage> {
    const row = ticket ? await byTicket(ctx.sql, hash(ticket)) : null;
    const p = row?.oauth.pending;
    if (!row || !p?.authorize || p.expiresAt < Date.now()) {
        return {kind: 'gone'};
    }
    if (!go) {
        return {kind: 'confirm', row};
    }
    const cookie = randomBytes(24).toString('base64url');
    if (!(await claimTicket(ctx.sql, row.id, hash(ticket), hash(cookie)))) {
        return {kind: 'gone'};
    }
    return {kind: 'go', row, cookie, location: p.authorize};
}

export type SignInResult = {ok: boolean; name: string; reason?: string};

// The sign-in page sends the browser back here with a code. The state names
// the connection and the person who started the sign-in, and can be used once.
export async function finishSignIn(ctx: Ctx, query: {code?: unknown; state?: unknown; error?: unknown}, cookies: Record<string, string>): Promise<SignInResult> {
    try {
        return await finish(ctx, query, cookies);
    } catch (e) {
        log.warn({err: (e as Error).message}, 'MCP sign-in failed');
        return {ok: false, name: 'The server', reason: 'The sign-in didn\'t finish. Start again from Captain.'};
    }
}

async function finish(ctx: Ctx, query: {code?: unknown; state?: unknown; error?: unknown}, cookies: Record<string, string>): Promise<SignInResult> {
    const state = typeof query.state === 'string' ? readState(query.state) : null;
    if (!state) {
        return {ok: false, name: 'The server', reason: 'This sign-in link has expired. Start again from Captain.'};
    }
    const row = await getMcp(ctx.sql, state.c);
    if (!row || row.userId !== state.u) {
        return {ok: false, name: 'The server', reason: 'This connection was removed. Start again from Captain.'};
    }
    const taken = await takePending(ctx.sql, row.id, state.n);
    if (!taken || taken.pending.expiresAt < Date.now()) {
        return {ok: false, name: row.name, reason: 'This sign-in was already used or has expired. Start again from Captain.'};
    }
    const cookie = cookies[browserCookie(row.id)];
    const want = taken.pending.browser;
    if (!cookie || !want || !safeEqual(hash(cookie), want)) {
        return {ok: false, name: row.name, reason: 'Finish signing in in the browser Captain opened. Start again from Captain on your computer.'};
    }
    if (typeof query.error === 'string' || typeof query.code !== 'string' || !query.code) {
        return {ok: false, name: row.name, reason: query.error === 'access_denied' ? 'You didn\'t allow access.' : 'The sign-in didn\'t finish.'};
    }
    const meta = taken.row.oauth.meta;
    const client = clientOf(taken.row.oauth);
    const verifier = decryptSecret(taken.pending.verifier);
    if (!meta || !client || !verifier) {
        return {ok: false, name: row.name, reason: 'The sign-in didn\'t finish. Start again from Captain.'};
    }
    try {
        const t = await exchangeCode(meta, client, query.code, verifier);
        const signedIn = await updateMcp(ctx.sql, row.id, {
            authMode: 'oauth', token: encryptSecret(t.accessToken), refreshToken: t.refreshToken ? encryptSecret(t.refreshToken) : null,
            oauth: {...taken.row.oauth, expiresAt: t.expiresAt}, status: 'unverified', lastError: null,
        });
        const checked = await verify(ctx, signedIn);
        return checked.status === 'connected' ? {ok: true, name: row.name} : {ok: false, name: row.name, reason: checked.lastError ?? 'Signed in, but the server didn\'t answer properly.'};
    } catch (e) {
        // A failed exchange: register again next time.
        await updateMcp(ctx.sql, row.id, {status: 'needs_sign_in', lastError: 'Sign-in failed. Try again.', oauth: {...taken.row.oauth, client: undefined}});
        return {ok: false, name: row.name, reason: e instanceof McpError ? e.message : 'The sign-in didn\'t finish.'};
    }
}
