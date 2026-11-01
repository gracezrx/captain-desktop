// HTTP for MCP servers and their sign-in: https to the public internet only
// (each address checked when the connection is made, so DNS can't point it
// back inside), no redirects followed, answers capped at 2 MB. Turning on
// MCP_ALLOW_PRIVATE lifts the address rule for servers on your own network.

import net from 'node:net';

import {Agent, fetch} from 'undici';

import {publicOnlyDispatcher} from '../../agents/tools/web.js';
import {config} from '../../config.js';

export const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_URL = 2048;

export class McpError extends Error {
    constructor(message: string, readonly status = 0, readonly wwwAuthenticate: string | null = null) {
        super(message);
    }
}

const anywhere = new Agent({connect: {timeout: 10_000}});

function dispatcher(): Agent {
    return config.connectors.mcpAllowPrivate ? anywhere : publicOnlyDispatcher();
}

// A server or sign-in address we're willing to call.
export function checkMcpUrl(raw: string): URL {
    const text = raw.trim();
    if (!text || text.length > MAX_URL || /[\x00-\x1f\x7f\s]/.test(text)) {
        throw new McpError('That isn\'t a valid server address.');
    }
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new McpError('That isn\'t a valid server address.');
    }
    const open = config.connectors.mcpAllowPrivate;
    if (url.protocol !== 'https:' && !(open && url.protocol === 'http:')) {
        throw new McpError('The server address must start with https://.');
    }
    if (url.username || url.password) {
        throw new McpError('Put a token in the token field, not in the address.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!open && (net.isIP(host) || /(^|\.)(localhost|internal|local|localdomain)$/i.test(host))) {
        throw new McpError('That address points inside a private network.');
    }
    url.hash = '';
    return url;
}

// The address as shown to people: no query string (it can carry a key).
export function displayUrl(raw: string): string {
    try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return '';
    }
}

export type HttpAnswer = {status: number; headers: Headers; text: string};

export async function call(url: string, init: {method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; signal?: AbortSignal}): Promise<HttpAnswer> {
    const target = checkMcpUrl(url);
    const signals = [AbortSignal.timeout(init.timeoutMs ?? 10_000), ...(init.signal ? [init.signal] : [])];
    let res;
    try {
        res = await fetch(target, {
            method: init.method ?? 'GET',
            headers: {'Accept-Encoding': 'identity', ...init.headers},
            body: init.body,
            redirect: 'manual',
            dispatcher: dispatcher(),
            signal: AbortSignal.any(signals),
        });
    } catch (e) {
        const err = e as Error & {cause?: Error};
        const why = err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError' ? 'took too long to answer' : err.cause?.message?.includes('private network') ? 'points inside a private network' : 'couldn\'t be reached';
        throw new McpError(`The server ${why}.`);
    }
    if (res.status >= 300 && res.status < 400) {
        throw new McpError(`The server answered with a redirect (HTTP ${res.status}).`, res.status);
    }
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_RESPONSE_BYTES) {
        throw new McpError('The server\'s answer was too large.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
        for await (const chunk of res.body) {
            size += (chunk as Uint8Array).byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                throw new McpError('The server\'s answer was too large.');
            }
            chunks.push(Buffer.from(chunk as Uint8Array));
        }
    }
    return {status: res.status, headers: res.headers as unknown as Headers, text: Buffer.concat(chunks).toString('utf8')};
}
