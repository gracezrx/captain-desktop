// Signing in to an MCP server (OAuth 2.1, as the MCP spec and Captain's main
// web product do it, backend/services/mcp_oauth.py):
// 1. discovery: the server's protected-resource metadata (the hint in its
//    401, then /.well-known/oauth-protected-resource), then its
//    authorization server's metadata;
// 2. dynamic client registration (a public client, no secret, unless the
//    server insists);
// 3. authorization code with PKCE (S256) and the `resource` parameter;
// 4. refresh before the access token runs out.
// Every address involved goes through the same network rules as the server.

import {createHash, randomBytes} from 'node:crypto';

import {call, checkMcpUrl, McpError} from './net.js';

export type OAuthMeta = {
    resource: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string | null;
    scope: string;
    discoveredAt: number;
};

export type OAuthClient = {clientId: string; clientSecret: string | null; redirectUri: string; issuer: string};
export type Tokens = {accessToken: string; refreshToken: string | null; expiresAt: number | null};

const json = (text: string): Record<string, unknown> | null => {
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
};

const sameResource = (a: string, b: string) => {
    const norm = (s: string) => {
        try {
            const u = new URL(s);
            return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
        } catch {
            return s;
        }
    };
    return norm(a) === norm(b);
};

async function getJson(url: string): Promise<{status: number; body: Record<string, unknown> | null}> {
    const res = await call(url, {headers: {Accept: 'application/json'}});
    return {status: res.status, body: res.status < 400 ? json(res.text) : null};
}

export function resourceMetadataHint(wwwAuthenticate: string | null): string | null {
    return wwwAuthenticate?.match(/resource_metadata\s*=\s*"([^"\r\n]+)"/i)?.[1] ?? null;
}

// Where and how to sign in to this MCP server.
export async function discover(serverUrl: string, hint: string | null): Promise<OAuthMeta> {
    const server = checkMcpUrl(serverUrl);
    const path = server.pathname.replace(/\/+$/, '');
    const candidates = [...new Set([
        ...(hint ? [hint] : []),
        `${server.origin}/.well-known/oauth-protected-resource${path}`,
        `${server.origin}/.well-known/oauth-protected-resource`,
    ])];
    let prm: Record<string, unknown> | null = null;
    for (const url of candidates) {
        const res = await getJson(url).catch(() => ({status: 0, body: null}));
        if (res.body) {
            prm = res.body;
            break;
        }
        if (res.status && res.status !== 404 && res.status !== 405) {
            break;
        }
    }
    const issuer = Array.isArray(prm?.authorization_servers) && typeof prm.authorization_servers[0] === 'string' ?
        prm.authorization_servers[0] as string :
        server.origin; // older servers are their own authorization server
    const resource = typeof prm?.resource === 'string' ? prm.resource : server.toString();
    if (!sameResource(resource, server.toString())) {
        throw new McpError('The sign-in is for a different server than this one.');
    }
    const is = checkMcpUrl(issuer);
    const isPath = is.pathname.replace(/\/+$/, '');
    let asm: Record<string, unknown> | null = null;
    for (const url of [`${is.origin}/.well-known/oauth-authorization-server${isPath}`, `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`]) {
        asm = (await getJson(url).catch(() => ({status: 0, body: null}))).body;
        if (asm) {
            break;
        }
    }
    if (!asm) {
        throw new McpError('This server doesn\'t say how to sign in to it. Add it with a token instead.');
    }
    if (typeof asm.issuer === 'string' && asm.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
        throw new McpError('The sign-in server didn\'t match what the MCP server named.');
    }
    const methods = Array.isArray(asm.code_challenge_methods_supported) ? asm.code_challenge_methods_supported : ['S256'];
    if (!methods.includes('S256')) {
        throw new McpError('This server\'s sign-in doesn\'t support PKCE.');
    }
    const endpoint = (v: unknown): string | null => (typeof v === 'string' && v ? checkMcpUrl(new URL(v, `${issuer.replace(/\/+$/, '')}/`).toString()).toString() : null);
    const authorizationEndpoint = endpoint(asm.authorization_endpoint);
    const tokenEndpoint = endpoint(asm.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) {
        throw new McpError('This server\'s sign-in is missing its endpoints.');
    }
    const scopes = Array.isArray(prm?.scopes_supported) ? (prm.scopes_supported as unknown[]).filter((s): s is string => typeof s === 'string') : [];
    if (Array.isArray(asm.scopes_supported) && asm.scopes_supported.includes('offline_access') && !scopes.includes('offline_access')) {
        scopes.push('offline_access');
    }
    return {
        resource, issuer, authorizationEndpoint, tokenEndpoint,
        registrationEndpoint: endpoint(asm.registration_endpoint), scope: scopes.join(' '), discoveredAt: Date.now(),
    };
}

// Register Captain as a client of this sign-in server.
export async function register(meta: OAuthMeta, redirectUri: string): Promise<OAuthClient> {
    if (!meta.registrationEndpoint) {
        throw new McpError('This server needs a client set up by hand, which Captain can\'t do. Add it with a token instead.');
    }
    const attempt = async (authMethod: 'none' | 'client_secret_post') => call(meta.registrationEndpoint!, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({
            client_name: 'Captain', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'], token_endpoint_auth_method: authMethod, ...(meta.scope ? {scope: meta.scope} : {}),
        }),
    });
    let res = await attempt('none');
    if ([400, 401, 403].includes(res.status)) {
        res = await attempt('client_secret_post');
    }
    const body = res.status < 400 ? json(res.text) : null;
    if (!body || typeof body.client_id !== 'string') {
        throw new McpError(`The server wouldn't register Captain (HTTP ${res.status}).`);
    }
    return {clientId: body.client_id, clientSecret: typeof body.client_secret === 'string' ? body.client_secret : null, redirectUri, issuer: meta.issuer};
}

const b64url = (b: Buffer) => b.toString('base64url');

export function pkce(): {verifier: string; challenge: string} {
    const verifier = b64url(randomBytes(48));
    return {verifier, challenge: b64url(createHash('sha256').update(verifier).digest())};
}

export function authorizeUrl(meta: OAuthMeta, client: OAuthClient, state: string, challenge: string): string {
    const url = new URL(meta.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', client.redirectUri);
    if (meta.scope) {
        url.searchParams.set('scope', meta.scope);
    }
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', meta.resource);
    return url.toString();
}

async function tokenRequest(meta: OAuthMeta, client: OAuthClient, fields: Record<string, string>): Promise<Tokens & {raw: Record<string, unknown>}> {
    const form = new URLSearchParams({client_id: client.clientId, resource: meta.resource, ...fields});
    if (client.clientSecret) {
        form.set('client_secret', client.clientSecret);
    }
    const res = await call(meta.tokenEndpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
        body: form.toString(),
    });
    const body = json(res.text);
    if (res.status >= 400 || !body || typeof body.access_token !== 'string' || !body.access_token) {
        throw new McpError(`The sign-in server didn't hand over access (HTTP ${res.status}).`, res.status);
    }
    if (typeof body.token_type === 'string' && body.token_type.toLowerCase() !== 'bearer') {
        throw new McpError('The sign-in server handed over an unusual kind of token.');
    }
    const expiresIn = Number(body.expires_in);
    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
        raw: body,
    };
}

export async function exchangeCode(meta: OAuthMeta, client: OAuthClient, code: string, verifier: string): Promise<Tokens> {
    const t = await tokenRequest(meta, client, {grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, code_verifier: verifier});
    return {accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt};
}

export async function refresh(meta: OAuthMeta, client: OAuthClient, refreshToken: string): Promise<Tokens> {
    const t = await tokenRequest(meta, client, {grant_type: 'refresh_token', refresh_token: refreshToken});
    return {accessToken: t.accessToken, refreshToken: t.refreshToken ?? refreshToken, expiresAt: t.expiresAt};
}
