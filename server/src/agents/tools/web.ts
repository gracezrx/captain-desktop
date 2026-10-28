// Reading the web: search (Tavily or Brave, when a key is set) and fetching a
// page as text. Fetching refuses private and internal addresses, so an agent
// can't be tricked into reading the server's own network.

import dns from 'node:dns/promises';
import net from 'node:net';

import {config} from '../../config.js';

import {str, type Tool} from './types.js';

const MAX_BYTES = 2 * 1024 * 1024;

function privateAddress(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && privateAddress(v.slice(7));
}

export async function assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('That isn\'t a valid web address.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https links can be read.');
    }
    if (url.username || url.password) {
        throw new Error('Links with credentials can\'t be read.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, {all: true})).map((a) => a.address);
    if (!addrs.length || addrs.some(privateAddress) || /(^|\.)(localhost|internal|local)$/i.test(host)) {
        throw new Error('That address points inside a private network, so it can\'t be read.');
    }
    return url;
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
    description: 'Read a public web page and get its text. Use for links people share or pages found by web_search.',
    parameters: {type: 'object', properties: {url: {type: 'string', description: 'The full http(s) address'}}, required: ['url']},
    external: false,
    available: () => true,
    async run(tc, args) {
        let url = await assertPublicUrl(str(args.url, 2000));
        for (let hop = 0; hop < 4; hop++) {
            const res = await fetch(url, {redirect: 'manual', signal: AbortSignal.any([tc.signal, AbortSignal.timeout(15_000)]), headers: {'User-Agent': 'CaptainBot/1.0 (+https://captainspace.ai)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5'}});
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
                continue;
            }
            if (!res.ok) {
                return {content: `The page answered ${res.status}.`};
            }
            const reader = res.body!.getReader();
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
