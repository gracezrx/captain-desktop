// Web search through OpenRouter when there's no Tavily or Brave key: the
// request asks for OpenRouter's web search, and the pages come back from the
// answer's citations (and any listed in its text).

import assert from 'node:assert/strict';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {config} from '../src/config.js';
import {useOpenRouterSearch, webSearch} from '../src/agents/tools/web.js';

describe('web search through OpenRouter', () => {
    let server: http.Server;
    let base = '';
    const seen: {auth?: string; body: Record<string, any>}[] = [];
    const was = {tavily: config.tools.tavilyKey, brave: config.tools.braveKey};

    before(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                seen.push({auth: req.headers.authorization, body: JSON.parse(raw)});
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({choices: [{message: {
                    content: 'Product Hunt launch guide | https://example.com/ph-guide | How to launch.\n- Another | https://example.org/more | More tips.',
                    annotations: [{type: 'url_citation', url_citation: {url: 'https://example.com/ph-guide', title: 'Product Hunt launch guide', content: 'Launch on a Tuesday.'}}],
                }}]}));
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
        config.tools.tavilyKey = '';
        config.tools.braveKey = '';
    });
    after(async () => {
        Object.assign(config.tools, {tavilyKey: was.tavily, braveKey: was.brave});
        useOpenRouterSearch(() => null);
        await new Promise((r) => server.close(() => r(null)));
    });

    it('is off without any key, and on with the OpenRouter key', () => {
        useOpenRouterSearch(() => null);
        assert.equal(webSearch.available(), false);
        useOpenRouterSearch(() => ({baseUrl: base, apiKey: 'or-key', model: 'cheap/model'}));
        assert.equal(webSearch.available(), true);
    });

    it('asks OpenRouter to search and returns the pages it cites', async () => {
        useOpenRouterSearch(() => ({baseUrl: base, apiKey: 'or-key', model: 'cheap/model'}));
        const res = await webSearch.run({signal: new AbortController().signal} as never, {query: 'product hunt launch tips'});
        const req = seen.at(-1)!;
        assert.equal(req.auth, 'Bearer or-key');
        assert.equal(req.body.model, 'cheap/model');
        assert.deepEqual(req.body.tools, [{type: 'openrouter:web_search', parameters: {max_results: 6}}]);
        assert.match(String(req.body.messages.at(-1).content), /product hunt launch tips/);
        assert.match(res.content, /1\. Product Hunt launch guide\nhttps:\/\/example\.com\/ph-guide\nLaunch on a Tuesday\./);
        assert.match(res.content, /2\. Another\nhttps:\/\/example\.org\/more/);
    });
});
