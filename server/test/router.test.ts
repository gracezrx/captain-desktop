// The model router and the agent runner against scripted OpenAI-compatible
// providers: tiers, fallbacks, the circuit breaker, budgets, tool calls,
// streaming, vision and parallel plan steps.

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {Catalog} from '../src/llm/catalog.js';

import {fakeProvider, type FakeRequest, lastUserText, model, signup, socket, startServer, systemText, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; userId: string; props: Record<string, any>};
type Run = {id: string; status: string; kind: string; rootPostId: string | null; steps: {status: string}[]};

describe('model routing and agent runs (scripted providers)', () => {
    let s: TestServer;
    let good: Awaited<ReturnType<typeof fakeProvider>>;
    let bad: Awaited<ReturnType<typeof fakeProvider>>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;
    let inflightSteps = 0;
    let maxParallelSteps = 0;

    const script = (req: FakeRequest) => {
        const system = systemText(req);
        const user = lastUserText(req);
        const last = req.messages.at(-1)!;
        if (system.includes('ROLE: PLANNER')) {
            if (/launch/.test(user)) {
                return {text: JSON.stringify({mode: 'plan', goal: 'Launch plan', steps: [
                    {id: 'a', agent: 'researcher', title: 'Research', instructions: 'Find facts', dependsOn: []},
                    {id: 'b', agent: 'designer', title: 'Visuals', instructions: 'Sketch the page', dependsOn: []},
                    {id: 'c', agent: 'writer', title: 'Write it', instructions: 'Write the plan', dependsOn: ['a', 'b']},
                ]})};
            }
            return {text: '{"mode":"direct"}'};
        }
        if (system.includes('ROLE: STEP')) {
            inflightSteps++;
            maxParallelSteps = Math.max(maxParallelSteps, inflightSteps);
            setTimeout(() => inflightSteps--, 400);
            const step = system.match(/Your step: (.+)/)![1];
            return {text: `output of ${step}${/teammates handed you/.test(user) ? ' (with inputs)' : ''}`, delayMs: 400};
        }
        if (system.includes('ROLE: SYNTHESIS')) {
            return {text: `combined: ${[...system.matchAll(/^### (.+)$/gm)].map((m) => m[1]).join(' | ')}`};
        }
        if (/look up kickoff/.test(user) && last.role === 'user') {
            return {toolCalls: [{name: 'search_workspace', args: {query: 'kickoff'}}]};
        }
        if (last.role === 'tool') {
            return {text: `Found: ${String(last.content).slice(0, 200)}`};
        }
        return {text: `answer from ${req.model}: ${'lorem ipsum '.repeat(20)}`};
    };

    before(async () => {
        good = await fakeProvider(script);
        bad = await fakeProvider(() => ({status: 503}));
        process.env.TEST_GOOD_KEY = 'good-key';
        process.env.TEST_BAD_KEY = 'bad-key';
        const catalog = new Catalog({
            providers: {
                good: {label: 'Good', baseUrl: good.url, apiKeyEnv: 'TEST_GOOD_KEY'},
                bad: {label: 'Bad', baseUrl: bad.url, apiKeyEnv: 'TEST_BAD_KEY'},
                nokey: {label: 'No key', baseUrl: good.url, apiKeyEnv: 'TEST_MISSING_KEY'},
            },
            models: [
                model('easy-a', 'easy', 100, [['bad', 'easy-a-upstream']]),
                model('easy-b', 'easy', 90, [['good', 'easy-b-upstream']]),
                model('bal', 'balanced', 100, [['nokey', 'x'], ['good', 'bal-upstream']]),
                model('eyes', 'balanced', 50, [['good', 'eyes-upstream']], {vision: true}),
                model('hard', 'hard', 100, [['good', 'hard-upstream']]),
            ],
        });
        s = await startServer({catalog});
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Routing'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
    });
    after(async () => {
        await s.stop();
        await good.close();
        await bad.close();
    });

    const ask = async (message: string, channelId = generalId): Promise<{run: Run; thread: Post[]}> => {
        const p = await owner.api.post(`/channels/${channelId}/posts`, {message});
        const run = await waitFor(async () => {
            const runs: Run[] = await owner.api.get(`/channels/${channelId}/runs`);
            return runs.find((r) => r.rootPostId === p.id && ['succeeded', 'failed', 'waiting_approval'].includes(r.status));
        }, 20_000, 'run');
        return {run, thread: await owner.api.get(`/posts/${p.id}/thread`)};
    };

    it('lists models with their configuration state', async () => {
        const {models, demoMode} = await owner.api.get(`/workspaces/${wsId}/models`);
        assert.equal(demoMode, false);
        assert.deepEqual(models.map((m: {id: string; configured: boolean}) => `${m.id}:${m.configured}`), ['easy-a:true', 'easy-b:true', 'bal:true', 'eyes:true', 'hard:true']);
    });

    it('falls back past a failing provider, then stops trying it (circuit breaker)', async () => {
        for (let i = 0; i < 4; i++) {
            const {run, thread} = await ask(`@captain hi ${i}`);
            assert.equal(run.status, 'succeeded');
            assert.equal(thread.at(-1)!.props.model.id, 'easy-b');
            assert.match(thread.at(-1)!.message, /answer from easy-b-upstream/);
        }
        assert.equal(bad.requests.length, 3, 'the failing route is skipped after three failures');
        const {models} = await owner.api.get(`/workspaces/${wsId}/models`);
        const a = models.find((m: {id: string}) => m.id === 'easy-a');
        assert.equal(a.healthy, false);
        assert.match(a.lastError, /503/);
    });

    it('routes demanding requests and demanding agents to the hard tier', async () => {
        const {thread} = await ask('@captain analyze the financial trade-offs of our pricing strategy in depth');
        assert.equal(thread.at(-1)!.props.model.id, 'hard');
        const planner = good.requests.filter((r) => systemText(r).includes('ROLE: PLANNER')).at(-1)!;
        assert.equal(planner.model, 'hard-upstream');

        const {thread: t2} = await ask('@analyst hi');
        assert.equal(t2.at(-1)!.props.model.id, 'hard', 'the analyst works at least at the hard tier');

        const {thread: t3} = await ask('@writer hi');
        assert.equal(t3.at(-1)!.props.model.id, 'bal', 'the writer works at least at the balanced tier, via its second route');
    });

    it('a pinned model is tried first', async () => {
        await owner.api.post(`/workspaces/${wsId}/agents`, {handle: 'pinned', name: 'Pinned', instructions: 'You always use the vision model for tests.', tier: 'easy', model: 'eyes', tools: []});
        const {thread} = await ask('@pinned hello');
        assert.equal(thread.at(-1)!.props.model.id, 'eyes');
    });

    it('streams partial text over the socket, then the final message', async () => {
        const live = await socket(s.base, owner.session.token);
        const {thread} = await ask('@captain hi stream');
        const reply = thread.at(-1)!;
        const streams = live.events.filter((e) => e.event === 'post_stream' && (e.data as {postId: string}).postId === reply.id);
        assert.ok(streams.length >= 1);
        const edited = live.events.filter((e) => e.event === 'post_edited' && (e.data as {post: Post}).post.id === reply.id);
        assert.equal((edited.at(-1)!.data as {post: Post}).post.props.streaming, false);
        live.close();
    });

    it('runs tools and feeds the results back to the model', async () => {
        await owner.api.post(`/channels/${generalId}/posts`, {message: 'Kickoff moved to Thursday 3pm'});
        const {run, thread} = await ask('@captain look up kickoff details please');
        assert.equal(run.status, 'succeeded');
        assert.match(thread.at(-1)!.message, /Found: .*Kickoff moved to Thursday 3pm/s);
        const toolTurn = good.requests.find((r) => r.messages.some((m) => m.role === 'tool'))!;
        assert.ok(toolTurn.messages.some((m) => m.role === 'assistant' && m.tool_calls));
        assert.ok(toolTurn.tools?.some((t) => t.function.name === 'search_workspace'));
    });

    it('sends screenshots only to models that can see', async () => {
        const form = new FormData();
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d5b9a30000000049454e44ae426082', 'hex');
        form.append('file', new Blob([png], {type: 'image/png'}), 'shot.png');
        const res = await fetch(`${s.base}/api/v1/channels/${generalId}/files`, {method: 'POST', headers: {Authorization: `Bearer ${owner.session.token}`}, body: form});
        const file = (await res.json()) as {id: string; width: number};
        assert.equal(file.width, 1);
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@researcher what is in this screenshot?', fileIds: [file.id]});
        await waitFor(async () => ((await owner.api.get(`/channels/${generalId}/runs`)) as Run[]).find((r) => r.rootPostId === p.id && r.status === 'succeeded'), 15_000, 'vision run');
        const req = good.requests.filter((r) => r.messages.some((m) => Array.isArray(m.content) && (m.content as {type: string}[]).some((c) => c.type === 'image_url'))).at(-1)!;
        assert.equal(req.model, 'eyes-upstream');
    });

    it('runs independent plan steps in parallel and passes outputs downstream', async () => {
        maxParallelSteps = 0;
        const {run, thread} = await ask('@captain put together a launch for the new app with research and visuals');
        assert.equal(run.kind, 'plan');
        assert.equal(run.status, 'succeeded');
        assert.equal(maxParallelSteps, 2, 'research and visuals ran at the same time');
        const steps = thread.filter((p) => p.type === 'agent_step').map((p) => p.message);
        assert.ok(steps.includes('output of Write it (with inputs)'));
        assert.match(thread.at(-1)!.message, /combined: Research \(@researcher\) \| Visuals \(@designer\) \| Write it \(@writer\)/);
    });

    it('stops at the monthly budget with a clear message', async () => {
        const usage = await owner.api.get(`/workspaces/${wsId}/usage`);
        assert.ok(usage.totalUsd > 0);
        assert.ok(usage.byModel.some((m: {modelId: string; tokensIn: number}) => m.modelId === 'easy-b' && m.tokensIn > 0));
        await owner.api.patch(`/workspaces/${wsId}`, {monthlyBudgetUsd: usage.totalUsd / 2});
        const before = good.requests.length;
        const {run, thread} = await ask('@captain hi budget');
        assert.equal(run.status, 'failed');
        assert.match(thread.at(-1)!.message, /AI budget/);
        assert.equal(good.requests.length, before, 'no model was called');
        await owner.api.patch(`/workspaces/${wsId}`, {monthlyBudgetUsd: null});
        const {run: ok} = await ask('@captain hi again');
        assert.equal(ok.status, 'succeeded');
    });
});
