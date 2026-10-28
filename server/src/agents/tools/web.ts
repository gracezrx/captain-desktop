// Reading the web: search (Tavily or Brave, when a key is set) and fetching a
// page as text.
//
// Fetching is locked down so an agent can't be used against the server's own
// network or to carry data out:
// - every address a hostname resolves to is checked when the connection is
//   made (no DNS rebinding), against private, loopback, link-local, mapped
//   and other non-public ranges; only ports 80 and 443
// - a page nobody linked (not in a person's message or a search result)
//   needs a person's approval, since the address itself could carry data

import dns from 'node:dns';
import net from 'node:net';

import {Agent, fetch as undiciFetch} from 'undici';

import {config} from '../../config.js';

import {str, type Tool} from './types.js';

const MAX_BYTES = 2 * 1024 * 1024;

const BLOCKED = new net.BlockList();
for (const [addr, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
    BLOCKED.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [
    ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
    BLOCKED.addSubnet(addr, bits, 'ipv6');
}

export function blockedAddress(ip: string): boolean {
    if (net.isIPv4(ip)) {
        return BLOCKED.check(ip, 'ipv4');
    }
    if (net.isIPv6(ip)) {
        return BLOCKED.check(ip, 'ipv6');
    }
    return true;
}

class BlockedError extends Error {}

// Resolve, refuse if any address is not public, and connect to exactly what was checked.
function safeLookup(hostname: string, options: dns.LookupOptions, callback: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void): void {
    dns.lookup(hostname, {...options, all: true}, (err, addresses) => {
        if (err) {
            callback(err, '');
            return;
        }
        const list = addresses as dns.LookupAddress[];
        if (!list.length || list.some((a) => blockedAddress(a.address))) {
            callback(new BlockedError('That address points inside a private network, so it can\'t be read.'), '');
            return;
        }
        if (options.all) {
            callback(null, list);
        } else {
            callback(null, list[0].address, list[0].family);
        }
    });
}

const dispatcher = new Agent({connect: {lookup: safeLookup as never, timeout: 10_000}});

export function checkUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new BlockedError('That isn\'t a valid web address.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new BlockedError('Only http and https links can be read.');
    }
    if (url.username || url.password) {
        throw new BlockedError('Links with credentials can\'t be read.');
    }
    if (url.port && url.port !== '80' && url.port !== '443') {
        throw new BlockedError('Only standard web ports can be read.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if ((net.isIP(host) && blockedAddress(host)) || /(^|\.)(localhost|internal|local|localdomain)$/i.test(host)) {
        throw new BlockedError('That address points inside a private network, so it can\'t be read.');
    }
    return url;
}

// Links that people shared or a search returned (an agent may read those freely).
export function linksIn(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.matchAll(/https?:\/\/(?:\[[0-9a-f:.]+\]|[^\s<>"'`)\]/]+)[^\s<>"'`)\]]*/gi)) {
        const href = normalize(m[0].replace(/[.,;:!?]+$/, ''));
        if (href) {
            out.add(href);
        }
    }
    return out;
}

function normalize(raw: string): string | null {
    try {
        const u = new URL(raw);
        u.hash = '';
        return u.href.replace(/\/$/, '');
    } catch {
        return null;
    }
}

export function htmlToText(html: string): {title: string; text: string} {
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
    const text = html.
        replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ').
        replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n').
        replace(/<[^>]+>/g, ' ').
        replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').
        replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
    return {title, text};
}

export const readUrl: Tool = {
    name: 'read_url',
    description: 'Read a public web page and get its text. Links people shared and web_search results open right away; any other address asks a person first.',
    parameters: {type: 'object', properties: {url: {type: 'string', description: 'The full http(s) address'}}, required: ['url']},
    external: false,
    available: () => true,
    needsApproval: (tc, args) => {
        const href = normalize(str(args.url, 2000));
        return !href || !tc.trustedLinks().has(href);
    },
    describe: (args) => ({
        title: `Open a web page: ${str(args.url, 120)}`,
        reason: 'Nobody shared this link, so the agent asks first: a web address can carry information out of the workspace.',
        fields: [{label: 'Address', value: str(args.url, 2000)}],
    }),
    async run(tc, args) {
        let url: URL;
        try {
            url = checkUrl(str(args.url, 2000));
        } catch (e) {
            return {content: (e as Error).message};
        }
        for (let hop = 0; hop < 4; hop++) {
            let res;
            try {
                res = await undiciFetch(url, {
                    redirect: 'manual',
                    dispatcher,
                    signal: AbortSignal.any([tc.signal, AbortSignal.timeout(15_000)]),
                    headers: {'User-Agent': 'CaptainBot/1.0 (+https://captainspace.ai)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5'},
                });
            } catch (e) {
                const cause = (e as {cause?: Error}).cause;
                if (cause instanceof BlockedError || e instanceof BlockedError) {
                    return {content: (cause ?? e as Error).message};
                }
                throw e;
            }
            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location) {
                await res.body?.cancel().catch(() => undefined);
                try {
                    url = checkUrl(new URL(location, url).toString());
                } catch (e) {
                    return {content: (e as Error).message};
                }
                continue;
            }
            if (!res.ok || !res.body) {
                await res.body?.cancel().catch(() => undefined);
                return {content: `The page answered ${res.status}.`};
            }
            const reader = res.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            for (;;) {
                const {done, value} = await reader.read();
                if (done) {
                    break;
                }
                size += value.length;
                if (size > MAX_BYTES) {
                    await reader.cancel();
                    break;
                }
                chunks.push(value);
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const type = res.headers.get('content-type') ?? '';
            const {title, text} = type.includes('html') ? htmlToText(body) : {title: '', text: body};
            return {content: `${title ? `Title: ${title}\n` : ''}URL: ${url}\n\n${text.slice(0, 12_000)}${text.length > 12_000 ? '\n\n[page truncated]' : ''}`};
        }
        return {content: 'The page redirected too many times.'};
    },
};

export const webSearch: Tool = {
    name: 'web_search',
    description: 'Search the web for current information. Returns titles, links and snippets; use read_url to read a result in full.',
    parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']},
    external: false,
    available: () => Boolean(config.tools.tavilyKey || config.tools.braveKey),
    async run(tc, args) {
        const query = str(args.query, 300);
        const signal = AbortSignal.any([tc.signal, AbortSignal.timeout(20_000)]);
        let results: {title: string; url: string; snippet: string}[] = [];
        if (config.tools.tavilyKey) {
            const res = await fetch('https://api.tavily.com/search', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.tools.tavilyKey}`}, body: JSON.stringify({query, max_results: 6}), signal});
            if (!res.ok) {
                throw new Error(`search answered ${res.status}`);
            }
            const json = (await res.json()) as {results?: {title: string; url: string; content: string}[]};
            results = (json.results ?? []).map((r) => ({title: r.title, url: r.url, snippet: r.content}));
        } else {
            const res = await fetch(`https://api.search.brave.com/res/v1/web/search?count=6&q=${encodeURIComponent(query)}`, {headers: {'X-Subscription-Token': config.tools.braveKey, Accept: 'application/json'}, signal});
            if (!res.ok) {
                throw new Error(`search answered ${res.status}`);
            }
            const json = (await res.json()) as {web?: {results?: {title: string; url: string; description: string}[]}};
            results = (json.web?.results ?? []).map((r) => ({title: r.title, url: r.url, snippet: htmlToText(r.description).text}));
        }
        if (!results.length) {
            return {content: 'No results.'};
        }
        return {content: results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet.slice(0, 400)}`).join('\n\n')};
    },
};
