// Model calls under pressure: answers are capped in length, rate limits are
// waited out, low credit asks for shorter answers, and calls to one provider
// are paced.

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {config} from '../src/config.js';
import {Catalog} from '../src/llm/catalog.js';
import {LlmError} from '../src/llm/types.js';

import {fakeProvider, model, signup, startServer, type TestServer} from './helpers.js';

const CREDIT = (asked: number) => `This request requires more credits, or fewer max_tokens. You requested up to ${asked} tokens, but can only afford 1200.`;

describe('model call limits', () => {
    let s: TestServer;
    let wsId: string;
    let flaky: Awaited<ReturnType<typeof fakeProvider>>;
    let poor: Awaited<ReturnType<typeof fakeProvider>>;
    let slow: Awaited<ReturnType<typeof fakeProvider>>;
    let inflight = 0;
    let maxInflight = 0;

    before(async () => {
        let flakyCalls = 0;
        flaky = await fakeProvider(() => (++flakyCalls <= 2 ? {status: 429, errorMessage: 'Rate limit exceeded'} : {text: 'ok after waiting'}));
        poor = await fakeProvider((req) => ((req.max_tokens ?? 1e9) > 1200 ? {status: 402, errorMessage: CREDIT(req.max_tokens ?? 0)} : {text: 'short answer'}));
        slow = await fakeProvider(() => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            setTimeout(() => inflight--, 250);
            return {text: 'slow answer', delayMs: 250};
        });
        process.env.TEST_LIMITS_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {
                flaky: {label: 'Flaky', baseUrl: flaky.url, apiKeyEnv: 'TEST_LIMITS_KEY'},
                poor: {label: 'Poor', baseUrl: poor.url, apiKeyEnv: 'TEST_LIMITS_KEY'},
                slow: {label: 'Slow', baseUrl: slow.url, apiKeyEnv: 'TEST_LIMITS_KEY'},
            },
            models: [
                model('m-flaky', 'easy', 100, [['flaky', 'flaky']]),
                model('m-poor', 'balanced', 100, [['poor', 'poor']]),
                model('m-slow', 'hard', 100, [['slow', 'slow']]),
            ],
        })});
        const owner = await signup(s.base, {workspaceName: 'Limits'});
        [{id: wsId}] = await owner.api.get('/workspaces');
    });
    after(async () => {
        await s.stop();
        await Promise.all([flaky.close(), poor.close(), slow.close()]);
    });

    const call = (pinned: string, purpose: 'reply' | 'classify' = 'reply') => s.instance.ctx.router.complete({
        workspaceId: wsId, purpose, tier: 'easy', pinnedModel: pinned, messages: [{role: 'user', content: 'hi'}],
    });

    it('caps every answer\'s length', async () => {
        await call('m-slow');
        assert.equal(slow.requests.at(-1)!.max_tokens, config.llm.maxOutputTokens);
        await call('m-slow', 'classify');
        assert.equal(slow.requests.at(-1)!.max_tokens, 16);
    });

    it('waits out a rate limit and tries the same model again', async () => {
        const res = await call('m-flaky');
        assert.equal(res.modelId, 'm-flaky');
        assert.equal(res.text, 'ok after waiting');
        assert.equal(flaky.requests.length, 3);
        const health = s.instance.ctx.router.modelHealth('m-flaky');
        assert.equal(health.healthy, true, 'rate limits don\'t mark the model as failing');
    });

    it('asks for a shorter answer when credit is low', async () => {
        const res = await call('m-poor');
        assert.equal(res.modelId, 'm-poor');
        assert.equal(res.text, 'short answer');
        assert.deepEqual(poor.requests.map((r) => r.max_tokens), [config.llm.maxOutputTokens, 960]);
        await call('m-poor');
        assert.deepEqual(poor.requests.map((r) => r.max_tokens), [config.llm.maxOutputTokens, 960, 960], 'the next call asks for what the account can afford');
    });

    it('paces calls to one provider', async () => {
        const was = config.llm.maxConcurrentPerProvider;
        config.llm.maxConcurrentPerProvider = 2;
        maxInflight = 0;
        try {
            await Promise.all(Array.from({length: 5}, () => call('m-slow')));
        } finally {
            config.llm.maxConcurrentPerProvider = was;
        }
        assert.equal(maxInflight, 2);
    });
});

describe('low credit on one provider', () => {
    let s: TestServer;
    let poor: Awaited<ReturnType<typeof fakeProvider>>;
    let rich: Awaited<ReturnType<typeof fakeProvider>>;
    let slow: Awaited<ReturnType<typeof fakeProvider>>;

    before(async () => {
        poor = await fakeProvider(() => ({status: 402, errorMessage: 'This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens, but can only afford 100.'}));
        rich = await fakeProvider(() => ({text: 'from the other provider'}));
        slow = await fakeProvider(() => ({text: 'slow', delayMs: 1500}));
        process.env.TEST_SPLIT_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {
                poor: {label: 'Poor', baseUrl: poor.url, apiKeyEnv: 'TEST_SPLIT_KEY'},
                rich: {label: 'Rich', baseUrl: rich.url, apiKeyEnv: 'TEST_SPLIT_KEY'},
                slow: {label: 'Slow', baseUrl: slow.url, apiKeyEnv: 'TEST_SPLIT_KEY'},
            },
            models: [model('m-split', 'easy', 100, [['poor', 'a'], ['rich', 'b']]), model('m-wait', 'hard', 100, [['slow', 'c']])],
        })});
    });
    after(async () => {
        await s.stop();
        await Promise.all([poor.close(), rich.close(), slow.close()]);
    });

    it('moves to the next provider without shrinking its answer', async () => {
        const owner = await signup(s.base, {workspaceName: 'Split'});
        const [{id}] = await owner.api.get('/workspaces');
        const res = await s.instance.ctx.router.complete({workspaceId: id, purpose: 'reply', tier: 'easy', pinnedModel: 'm-split', messages: [{role: 'user', content: 'hi'}]});
        assert.equal(res.provider, 'rich');
        assert.equal(poor.requests.length, 1, 'too little credit to be worth a shorter try');
        assert.equal(rich.requests[0].max_tokens, config.llm.maxOutputTokens);
    });

    it('a stopped run stops waiting for its turn', async () => {
        const owner = await signup(s.base, {workspaceName: 'Waiting'});
        const [{id}] = await owner.api.get('/workspaces');
        const was = config.llm.maxConcurrentPerProvider;
        config.llm.maxConcurrentPerProvider = 1;
        try {
            const call = (signal?: AbortSignal) => s.instance.ctx.router.complete({workspaceId: id, purpose: 'reply', tier: 'hard', pinnedModel: 'm-wait', messages: [{role: 'user', content: 'hi'}], signal});
            const first = call();
            const ctrl = new AbortController();
            const second = call(ctrl.signal);
            const started = Date.now();
            setTimeout(() => ctrl.abort(), 100);
            await assert.rejects(second, /cancelled/);
            assert.ok(Date.now() - started < 1000, 'it stops right away, not when the first call ends');
            await first;
        } finally {
            config.llm.maxConcurrentPerProvider = was;
        }
    });
});

describe('out of credit', () => {
    let s: TestServer;
    let broke: Awaited<ReturnType<typeof fakeProvider>>;

    before(async () => {
        broke = await fakeProvider(() => ({status: 402, errorMessage: 'Insufficient credits'}));
        process.env.TEST_BROKE_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {broke: {label: 'Broke', baseUrl: broke.url, apiKeyEnv: 'TEST_BROKE_KEY'}},
            models: [model('m-broke', 'easy', 100, [['broke', 'broke']])],
        })});
    });
    after(async () => {
        await s.stop();
        await broke.close();
    });

    it('says the account needs credit, plainly', async () => {
        const owner = await signup(s.base, {workspaceName: 'Broke'});
        const [{id}] = await owner.api.get('/workspaces');
        await assert.rejects(
            s.instance.ctx.router.complete({workspaceId: id, purpose: 'reply', tier: 'easy', messages: [{role: 'user', content: 'hi'}]}),
            (e: unknown) => e instanceof LlmError && e.status === 402 && /enough credit/.test(e.message),
        );
    });
});
