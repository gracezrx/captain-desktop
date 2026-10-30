// An agent's conversation is saved while it waits for a person, and sent back
// to the model unchanged after the decision. Providers refuse a conversation
// whose tool messages lost their tool_call_id, so this provider does too.

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {Catalog} from '../src/llm/catalog.js';

import {fakeProvider, type FakeRequest, lastUserText, model, signup, startServer, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; props: Record<string, any>};
type Run = {id: string; status: string; rootPostId: string | null; error: string | null};
type Msg = {role: string; content: unknown; tool_calls?: {id: string}[]; tool_call_id?: string};

// What OpenAI-compatible providers check: every tool message answers a tool
// call the assistant made earlier in the conversation.
function invalid(req: FakeRequest): string | null {
    const calls = new Set<string>();
    for (const [i, m] of (req.messages as Msg[]).entries()) {
        for (const c of m.tool_calls ?? []) {
            calls.add(c.id);
        }
        if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || !m.tool_call_id)) {
            return `messages[${i}]: tool messages must include a non-empty string tool_call_id`;
        }
        if (m.role === 'tool' && !calls.has(m.tool_call_id!)) {
            return `messages[${i}]: tool_call_id ${m.tool_call_id} doesn't match a tool call`;
        }
    }
    return null;
}

describe('resuming after an approval', () => {
    let s: TestServer;
    let llm: Awaited<ReturnType<typeof fakeProvider>>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let generalId: string;

    before(async () => {
        llm = await fakeProvider((req) => {
            const bad = invalid(req);
            if (bad) {
                return {status: 400, errorMessage: bad};
            }
            const msgs = req.messages as Msg[];
            const tools = msgs.filter((m) => m.role === 'tool');
            if (!/kickoff/.test(lastUserText(req)) || !req.tools?.length) {
                return {text: 'ok'};
            }
            if (tools.length === 0) {
                return {toolCalls: [{name: 'search_workspace', args: {query: 'kickoff'}}]};
            }
            if (tools.length === 1) {
                return {toolCalls: [{name: 'send_email', args: {to: 'team@example.com', subject: 'Kickoff', body: 'See you Monday.'}}]};
            }
            return {text: 'Emailed the team about the kickoff.'};
        });
        process.env.TEST_RESUME_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {p: {label: 'P', baseUrl: llm.url, apiKeyEnv: 'TEST_RESUME_KEY'}},
            models: [model('m', 'easy', 1, [['p', 'm']]), model('b', 'balanced', 1, [['p', 'b']]), model('h', 'hard', 1, [['p', 'h']])],
        })});
        owner = await signup(s.base, {name: 'Ada', workspaceName: 'Resume'});
        const [{id: wsId}] = await owner.api.get('/workspaces');
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
    });
    after(async () => {
        await s.stop();
        await llm.close();
    });

    it('sends the saved conversation back with its tool call ids', async () => {
        const p: Post = await owner.api.post(`/channels/${generalId}/posts`, {message: '@writer look up the kickoff, then email the team about it'});
        const runOf = async () => ((await owner.api.get(`/channels/${generalId}/runs`)) as Run[]).find((r) => r.rootPostId === p.id);
        const waiting = await waitFor(async () => {
            const r = await runOf();
            return r && ['waiting_approval', 'succeeded', 'failed'].includes(r.status) ? r : null;
        }, 15_000, 'the approval');
        assert.equal(waiting.status, 'waiting_approval', waiting.error ?? '');
        const card = ((await owner.api.get(`/posts/${p.id}/thread`)) as Post[]).find((x) => x.type === 'decision')!;
        await owner.api.post(`/posts/${card.id}/actions/approve`);

        const done = await waitFor(async () => {
            const r = await runOf();
            return r && ['succeeded', 'failed'].includes(r.status) ? r : null;
        }, 15_000, 'the run to finish');
        assert.equal(done.status, 'succeeded', done.error ?? '');
        const refused = llm.requests.filter((r) => invalid(r));
        assert.deepEqual(refused.map(invalid), [], 'no conversation was refused');
        const thread: Post[] = await owner.api.get(`/posts/${p.id}/thread`);
        assert.match(thread.at(-1)!.message, /Emailed the team/);
    });
});
