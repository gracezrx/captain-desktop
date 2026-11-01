// The Home dashboard: tasks in progress and finished, limited to channels you
// can see, with tokens burned for owners and admins.

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {Catalog} from '../src/llm/catalog.js';
import {localDayStart} from '../src/store/dashboard.js';

import {fakeProvider, lastUserText, model, signup, startServer, type TestServer, waitFor} from './helpers.js';

type ActivityRun = {id: string; status: string; goal: string; agentId: string; requestedBy: string; channelId: string; tokens: number; costUsd: number};
type Dashboard = {
    active: ActivityRun[]; recent: ActivityRun[];
    counts: {active: number; waiting: number; doneToday: number; failedToday: number; doneWeek: number};
    usage: null | {today: {tokensIn: number; tokensOut: number; calls: number}; month: {tokensIn: number; usd: number}; daily: {day: number; tokens: number}[]; byAgent: {agentId: string | null; tokens: number}[]; budgetUsd: number | null};
};

describe('home dashboard', () => {
    let s: TestServer;
    let llm: Awaited<ReturnType<typeof fakeProvider>>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let member: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;
    let agents: {id: string; handle: string}[];

    before(async () => {
        llm = await fakeProvider((req) => ({text: 'Here you go.', delayMs: /slowly/.test(lastUserText(req)) ? 1500 : 0}));
        process.env.TEST_DASH_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {fake: {label: 'Fake', baseUrl: llm.url, apiKeyEnv: 'TEST_DASH_KEY'}},
            models: [model('m-easy', 'easy', 100, [['fake', 'm']]), model('m-bal', 'balanced', 100, [['fake', 'm']]), model('m-hard', 'hard', 100, [['fake', 'm']])],
        })});
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Dash'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        member = await signup(s.base, {name: 'Mia', invite: invite.token});
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
        agents = (await owner.api.get(`/workspaces/${wsId}/agents`)).agents;
    });
    after(async () => {
        await s.stop();
        await llm.close();
    });

    const dash = (api: typeof owner.api, tz = 240): Promise<Dashboard> => api.get(`/workspaces/${wsId}/dashboard?tz=${tz}`);

    it('shows a task while it runs, then as done, with its tokens', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@researcher look into this slowly please'});
        const running = await waitFor(async () => (await dash(owner.api)).active.find((r) => r.goal.includes('slowly')), 5000, 'run in progress');
        assert.equal(running.agentId, agents.find((a) => a.handle === 'researcher')!.id);
        const during = await dash(owner.api);
        assert.ok(during.counts.active >= 1);

        const done = await waitFor(async () => (await dash(owner.api)).recent.find((r) => r.goal.includes('slowly') && r.status === 'succeeded'), 10_000, 'run done');
        assert.equal(done.tokens, 1500, 'tokens in + out of its model call');
        assert.ok(p.id);
        const after = await dash(owner.api);
        assert.equal(after.active.some((r) => r.id === done.id), false);
        assert.ok(after.counts.doneToday >= 1);
    });

    it('owners see tokens burned: today, the month, by day and by agent', async () => {
        const {usage} = await dash(owner.api);
        assert.ok(usage);
        assert.ok(usage.today.tokensIn >= 1000 && usage.today.tokensOut >= 500);
        assert.ok(usage.month.usd > 0);
        assert.equal(usage.daily.length, 14);
        assert.equal(usage.daily.at(-1)!.day, localDayStart(Date.now(), 240), 'the last bar is today, in your time zone');
        assert.ok(usage.daily.at(-1)!.tokens >= 1500);
        assert.ok(usage.byAgent.some((a) => a.agentId === agents.find((x) => x.handle === 'researcher')!.id && a.tokens >= 1500));
        assert.equal(usage.budgetUsd, 20);
    });

    it('members see the tasks in their channels, but not spend', async () => {
        const secret = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Founders', type: 'P'});
        await owner.api.post(`/channels/${secret.id}/posts`, {message: '@writer draft the board update'});
        await waitFor(async () => (await dash(owner.api)).recent.find((r) => r.channelId === secret.id), 10_000, 'private run done');

        const mine = await dash(member.api);
        assert.equal(mine.usage, null);
        assert.ok(mine.recent.every((r) => r.tokens === 0 && r.costUsd === 0), 'no per-task spend for members');
        assert.ok(mine.recent.some((r) => r.goal.includes('slowly')), 'a task in #general');
        assert.equal(mine.recent.some((r) => r.channelId === secret.id), false, 'not a task in a channel Mia isn\'t in');
    });

    it('token use per chat: everyone in the chat sees tokens, only admins see dollars', async () => {
        const home = (await dash(owner.api)).usage as Dashboard['usage'] & {byChat: {channelId: string; name: string; tokens: number; usd: number}[]};
        const general = home.byChat.find((c) => c.channelId === generalId)!;
        assert.ok(general.tokens >= 1500, 'the chat the work was for');
        assert.ok(home.byChat.some((c) => c.name === 'Founders' && c.tokens > 0), 'admins see every chat on Home');

        type ChatUsage = {month: {tokensIn: number; tokensOut: number; usd: number; calls: number}; byAgent: {agentId: string; tokens: number; usd: number}[]; showsUsd: boolean};
        const forOwner: ChatUsage = await owner.api.get(`/channels/${generalId}/usage?tz=240`);
        assert.equal(forOwner.month.tokensIn + forOwner.month.tokensOut, general.tokens);
        assert.ok(forOwner.month.usd > 0);
        assert.equal(forOwner.showsUsd, true);
        const forMember: ChatUsage = await member.api.get(`/channels/${generalId}/usage?tz=240`);
        assert.equal(forMember.month.tokensIn + forMember.month.tokensOut, general.tokens);
        assert.equal(forMember.month.usd, 0);
        assert.ok(forMember.byAgent.every((a) => a.usd === 0));
        assert.equal(forMember.showsUsd, false);
        const founders = home.byChat.find((c) => c.name === 'Founders')!;
        await assert.rejects(member.api.get(`/channels/${founders.channelId}/usage`), 'not a chat Mia is in');
    });

    it('ignores a nonsense time zone', async () => {
        const res = await owner.api.get(`/workspaces/${wsId}/dashboard?tz=banana`) as Dashboard;
        assert.equal(res.usage!.daily.at(-1)!.day, localDayStart(Date.now(), 0));
    });

    it('needs a workspace you belong to', async () => {
        const stranger = await signup(s.base, {name: 'Sam', workspaceName: 'Elsewhere'});
        await assert.rejects(dash(stranger.api));
    });
});
