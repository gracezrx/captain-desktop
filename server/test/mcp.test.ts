// MCP servers, against a stand-in server that speaks Streamable HTTP and
// signs in with OAuth 2.1 (discovery, dynamic registration, PKCE): adding
// one, signing in through the callback (once), agents reading through it
// without asking and changing things only after your approval, refreshing
// an expired sign-in, a server with a key in its own header, and keeping
// it all to the person who connected it.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {config} from '../src/config.js';
import {Catalog} from '../src/llm/catalog.js';

import {expectStatus, fakeProvider, type FakeRequest, lastUserText, model, signup, startServer, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; userId: string; props: Record<string, any>};
type Run = {id: string; status: string; rootPostId: string | null; error: string | null};
type Server = {id: string; name: string; status: string; lastError: string | null; authMode: string; url: string; tools: {name: string; reads: boolean}[]};

function fakeMcp() {
    const calls: {name: string; args: unknown; auth: string | undefined}[] = [];
    const state = {accepted: new Set(['tok-1']), challenge: '', registered: 0, sessions: 0};
    let base = '';
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url!, 'http://x');
            const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
                res.writeHead(status, {'Content-Type': 'application/json', ...headers});
                res.end(body === undefined ? '' : JSON.stringify(body));
            };
            if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
                return send(200, {resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp']});
            }
            if (url.pathname === '/.well-known/oauth-authorization-server') {
                return send(200, {issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256']});
            }
            if (url.pathname === '/register' && req.method === 'POST') {
                const body = JSON.parse(raw);
                assert.equal(body.token_endpoint_auth_method, 'none');
                state.registered++;
                return send(201, {client_id: 'client-1', redirect_uris: body.redirect_uris});
            }
            if (url.pathname === '/token' && req.method === 'POST') {
                const form = new URLSearchParams(raw);
                if (form.get('grant_type') === 'authorization_code') {
                    const verifier = form.get('code_verifier') ?? '';
                    const ok = form.get('code') === 'code-ok' && createHash('sha256').update(verifier).digest('base64url') === state.challenge && form.get('client_id') === 'client-1' && form.get('resource') === `${base}/mcp`;
                    return ok ? send(200, {access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600, token_type: 'Bearer'}) : send(400, {error: 'invalid_grant'});
                }
                if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'ref-1') {
                    state.accepted.add('tok-2');
                    return send(200, {access_token: 'tok-2', expires_in: 3600, token_type: 'Bearer'});
                }
                return send(400, {error: 'invalid_grant'});
            }
            if ((url.pathname === '/mcp' || url.pathname === '/keyed') && req.method === 'POST') {
                const auth = url.pathname === '/keyed' ? req.headers['x-api-key'] as string | undefined : (req.headers.authorization ?? '').replace(/^Bearer /, '');
                const ok = url.pathname === '/keyed' ? auth === 'k1' : state.accepted.has(auth ?? '');
                if (!ok) {
                    return send(401, {error: 'unauthorized'}, {'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`});
                }
                const msg = JSON.parse(raw);
                if (msg.method === 'notifications/initialized') {
                    return send(202, undefined);
                }
                if (msg.method === 'initialize') {
                    state.sessions++;
                    return send(200, {jsonrpc: '2.0', id: msg.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'Fake notes'}}}, {'Mcp-Session-Id': `s${state.sessions}`});
                }
                assert.ok(req.headers['mcp-session-id'], 'the session id comes back');
                if (msg.method === 'tools/list') {
                    // As an event stream, like many servers answer.
                    res.writeHead(200, {'Content-Type': 'text/event-stream'});
                    res.end(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: msg.id, result: {tools: [
                        {name: 'query_meetings', description: 'Search meeting notes.', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}, annotations: {readOnlyHint: true}},
                        {name: 'list_meetings', description: 'Recent meetings.', inputSchema: {type: 'object', properties: {}}},
                        {name: 'create_note', description: 'Add a note.', inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}},
                    ]}})}\n\n`);
                    return;
                }
                if (msg.method === 'tools/call') {
                    calls.push({name: msg.params.name, args: msg.params.arguments, auth});
                    const text = msg.params.name === 'query_meetings' ? 'Launch sync: ship Tuesday, Mia owns the gallery.' : msg.params.name === 'create_note' ? 'Note added.' : 'No meetings.';
                    return send(200, {jsonrpc: '2.0', id: msg.id, result: {content: [{type: 'text', text}]}});
                }
                return send(200, {jsonrpc: '2.0', id: msg.id, error: {code: -32601, message: 'secret internals'}});
            }
            return send(404, {error: 'not found'});
        });
    });
    return {server, calls, state, setBase: (b: string) => (base = b)};
}

describe('MCP servers', () => {
    let s: TestServer;
    let llm: Awaited<ReturnType<typeof fakeProvider>>;
    let fake: ReturnType<typeof fakeMcp>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let member: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;
    let base: string;
    let notes: Server;
    const was = {allow: config.connectors.mcpAllowPrivate, publicUrl: config.publicUrl};

    before(async () => {
        fake = fakeMcp();
        await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
        fake.setBase(base);
        llm = await fakeProvider((req: FakeRequest) => {
            const last = req.messages.at(-1)!;
            if (last.role === 'tool') {
                return {text: `Here's what I found. ${String(last.content)}`};
            }
            const tools = (req.tools ?? []).map((t) => t.function.name);
            if (/add a note/.test(lastUserText(req)) && tools.includes('mcp_notes_create_note')) {
                return {toolCalls: [{name: 'mcp_notes_create_note', args: {text: 'Ship Tuesday'}}]};
            }
            if (/meeting notes/.test(lastUserText(req)) && tools.includes('mcp_notes_query_meetings')) {
                return {toolCalls: [{name: 'mcp_notes_query_meetings', args: {query: 'launch'}}]};
            }
            return {text: tools.some((t) => t.startsWith('mcp_')) ? `has mcp: ${tools.filter((t) => t.startsWith('mcp_')).join(',')}` : 'no mcp'};
        });
        process.env.TEST_MCP_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {p: {label: 'P', baseUrl: llm.url, apiKeyEnv: 'TEST_MCP_KEY'}},
            models: [model('m', 'easy', 1, [['p', 'm']]), model('b', 'balanced', 1, [['p', 'b']]), model('h', 'hard', 1, [['p', 'h']])],
        })});
        config.publicUrl = s.base;
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'MCP'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        member = await signup(s.base, {name: 'Mia', invite: invite.token});
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
    });
    after(async () => {
        Object.assign(config.connectors, {mcpAllowPrivate: was.allow});
        config.publicUrl = was.publicUrl;
        await s.stop();
        await llm.close();
        await new Promise((r) => fake.server.close(() => r(null)));
    });

    const ask = async (api: typeof owner.api, message: string) => {
        const p: Post = await api.post(`/channels/${generalId}/posts`, {message});
        const run = await waitFor(async () => ((await api.get(`/channels/${generalId}/runs`)) as Run[]).find((r) => r.rootPostId === p.id && ['succeeded', 'failed', 'waiting_approval'].includes(r.status)), 15_000, 'run');
        const thread: Post[] = await api.get(`/posts/${p.id}/thread`);
        return {post: p, run, thread};
    };

    it('offers Granola, Notion and Linear, and refuses servers on a private network', async () => {
        const list = await owner.api.get(`/workspaces/${wsId}/mcp`);
        assert.deepEqual(list.presets.map((p: {id: string}) => p.id), ['granola', 'notion', 'linear']);
        assert.deepEqual(list.servers, []);
        config.connectors.mcpAllowPrivate = false;
        const err = await expectStatus(owner.api.post(`/workspaces/${wsId}/mcp`, {url: `${base}/mcp`}), 400);
        assert.match(err.message, /https/);
        await expectStatus(owner.api.post(`/workspaces/${wsId}/mcp`, {url: 'https://127.0.0.1/mcp'}), 400);
        await expectStatus(owner.api.post(`/workspaces/${wsId}/mcp`, {url: 'https://user:pw@example.com/mcp'}), 400);
        config.connectors.mcpAllowPrivate = true;
    });

    it('a server that wants a sign-in: Captain finds how, registers, and hands back the page to open', async () => {
        const res = await owner.api.post(`/workspaces/${wsId}/mcp`, {url: `${base}/mcp?key=secret`, name: 'Notes'});
        assert.equal(res.server.status, 'needs_sign_in');
        assert.equal(res.server.authMode, 'oauth');
        assert.equal(res.server.url, `${base}/mcp`, 'shown without its query string');
        const sign = new URL(res.signInUrl);
        assert.equal(sign.origin + sign.pathname, `${base}/authorize`);
        assert.equal(sign.searchParams.get('client_id'), 'client-1');
        assert.equal(sign.searchParams.get('redirect_uri'), `${s.base}/mcp/oauth/callback`);
        assert.equal(sign.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(sign.searchParams.get('scope'), 'mcp');
        assert.equal(sign.searchParams.get('resource'), `${base}/mcp`, 'the server as its metadata names it');
        fake.state.challenge = sign.searchParams.get('code_challenge')!;
        notes = res.server;
        (notes as Server & {state: string}).state = sign.searchParams.get('state')!;
    });

    it('signing in finishes on Captain\'s page, once; a forged or reused link does nothing', async () => {
        const state = (notes as Server & {state: string}).state;
        const forged = await (await fetch(`${s.base}/mcp/oauth/callback?code=code-ok&state=${encodeURIComponent(state.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))}`)).text();
        assert.match(forged, /expired/);
        const page = await (await fetch(`${s.base}/mcp/oauth/callback?code=code-ok&state=${encodeURIComponent(state)}`)).text();
        assert.match(page, /Notes is connected/);
        const again = await (await fetch(`${s.base}/mcp/oauth/callback?code=code-ok&state=${encodeURIComponent(state)}`)).text();
        assert.match(again, /already used/);
        const [server]: Server[] = (await owner.api.get(`/workspaces/${wsId}/mcp`)).servers;
        assert.equal(server.status, 'connected');
        assert.deepEqual(server.tools, [{name: 'query_meetings', reads: true}, {name: 'list_meetings', reads: true}, {name: 'create_note', reads: false}]);
        assert.ok(!JSON.stringify(server).includes('tok-1'), 'no token material comes back');
    });

    it('an agent reads through it without asking, as you', async () => {
        const {run, thread} = await ask(owner.api, '@researcher what do the meeting notes say about the launch?');
        assert.equal(run.status, 'succeeded', run.error ?? '');
        assert.deepEqual(fake.calls.at(-1), {name: 'query_meetings', args: {query: 'launch'}, auth: 'tok-1'});
        assert.match(thread.at(-1)!.message, /ship Tuesday, Mia owns the gallery/);
        assert.ok(!thread.some((p) => p.type === 'decision'));
    });

    it('changing something waits for your approval, and only yours', async () => {
        const {post, run} = await ask(owner.api, '@writer add a note to my meeting notes');
        assert.equal(run.status, 'waiting_approval');
        const card = ((await owner.api.get(`/posts/${post.id}/thread`)) as Post[]).find((p) => p.type === 'decision')!;
        assert.equal(card.props.decision.title, 'Notes: create note');
        assert.equal(card.props.decision.tool, 'mcp_notes_create_note');
        assert.ok(!fake.calls.some((c) => c.name === 'create_note'), 'not before approval');
        await owner.api.patch(`/workspaces/${wsId}/members/${(await member.api.get('/users/me')).id}`, {role: 'admin'});
        await expectStatus(member.api.post(`/posts/${card.id}/actions/approve`), 403);
        await owner.api.post(`/posts/${card.id}/actions/approve`);
        await waitFor(async () => fake.calls.some((c) => c.name === 'create_note'), 15_000, 'called after approval');
        assert.deepEqual(fake.calls.find((c) => c.name === 'create_note')!.args, {text: 'Ship Tuesday'});
    });

    it('when the sign-in runs out, Captain refreshes it and carries on', async () => {
        fake.state.accepted.delete('tok-1');
        const {run} = await ask(owner.api, '@researcher check the meeting notes again');
        assert.equal(run.status, 'succeeded', run.error ?? '');
        assert.equal(fake.calls.at(-1)!.auth, 'tok-2');
    });

    it('your servers are yours: Mia\'s agents don\'t get them', async () => {
        const {thread} = await ask(member.api, '@researcher anything in the meeting notes?');
        assert.match(thread.at(-1)!.message, /no mcp/);
        assert.deepEqual((await member.api.get(`/workspaces/${wsId}/mcp`)).servers, []);
        await expectStatus(member.api.post(`/workspaces/${wsId}/mcp/${notes.id}/verify`), 404);
        await expectStatus(member.api.del(`/workspaces/${wsId}/mcp/${notes.id}`), 404);
    });

    it('a server with a key in its own header', async () => {
        await expectStatus(owner.api.post(`/workspaces/${wsId}/mcp`, {url: `${base}/keyed`, token: 'k1', authHeader: 'Authorization'}), 400);
        const wrong = await owner.api.post(`/workspaces/${wsId}/mcp`, {url: `${base}/keyed`, token: 'nope', authHeader: 'X-Api-Key', name: 'Keyed'});
        assert.equal(wrong.server.status, 'error');
        assert.equal(wrong.signInUrl, null);
        const right = await owner.api.post(`/workspaces/${wsId}/mcp`, {url: `${base}/keyed`, token: 'k1', authHeader: 'X-Api-Key'});
        assert.equal(right.server.id, wrong.server.id, 'the same connection, with the new key');
        assert.equal(right.server.status, 'connected');
        const {thread} = await ask(owner.api, '@researcher which tools do you have?');
        assert.match(thread.at(-1)!.message, /mcp_keyed_query_meetings/);
    });

    it('switching one off and removing it', async () => {
        await owner.api.patch(`/workspaces/${wsId}/mcp/${notes.id}`, {enabled: false});
        let {thread} = await ask(owner.api, '@researcher which tools now?');
        assert.doesNotMatch(thread.at(-1)!.message, /mcp_notes_/);
        await owner.api.del(`/workspaces/${wsId}/mcp/${notes.id}`);
        assert.equal((await owner.api.get(`/workspaces/${wsId}/mcp`)).servers.length, 1);
        ({thread} = await ask(owner.api, '@researcher and now?'));
        assert.doesNotMatch(thread.at(-1)!.message, /mcp_notes_/);
    });
});
