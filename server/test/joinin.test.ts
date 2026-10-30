// Captain joins a group chat on its own when it can help, and stays quiet
// otherwise: small talk, a message to a person, a chat that turned it off,
// or right after it joined in.

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {config} from '../src/config.js';
import {Catalog} from '../src/llm/catalog.js';

import {fakeProvider, type FakeRequest, model, signup, startServer, systemText, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; userId: string; props: Record<string, any>};
type Run = {id: string; status: string; rootPostId: string | null; triggerPostId: string | null};

const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

describe('Captain joins in', () => {
    let s: TestServer;
    let llm: Awaited<ReturnType<typeof fakeProvider>>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;
    const was = {delay: config.agents.joinInDelayMs, cooldown: config.agents.joinInCooldownMs};

    before(async () => {
        config.agents.joinInDelayMs = 50;
        llm = await fakeProvider((req: FakeRequest) => {
            const sys = systemText(req);
            if (sys.includes('ROLE: JOIN-IN')) {
                const last = String((req.messages.at(-1)!.content as string).split('\n').at(-1));
                return {text: /\?/.test(last) ? 'YES' : 'NO'};
            }
            if (sys.includes('ROLE: PLANNER')) {
                return {text: '{"mode":"direct"}'};
            }
            return {text: sys.includes('Nobody asked you directly') ? 'Churn was 14% last month.' : 'asked directly'};
        });
        process.env.TEST_JOIN_KEY = 'k';
        s = await startServer({catalog: new Catalog({
            providers: {p: {label: 'P', baseUrl: llm.url, apiKeyEnv: 'TEST_JOIN_KEY'}},
            models: [model('m', 'easy', 1, [['p', 'm']]), model('b', 'balanced', 1, [['p', 'b']]), model('h', 'hard', 1, [['p', 'h']])],
        })});
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Join'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
    });
    after(async () => {
        Object.assign(config.agents, {joinInDelayMs: was.delay, joinInCooldownMs: was.cooldown});
        await s.stop();
        await llm.close();
    });

    const runsFor = async (channelId: string, postId: string) => ((await owner.api.get(`/channels/${channelId}/runs`)) as Run[]).filter((r) => r.triggerPostId === postId);

    it('answers a question nobody asked it, in the thread, marked as joining in', async () => {
        config.agents.joinInCooldownMs = 180_000;
        const p: Post = await owner.api.post(`/channels/${generalId}/posts`, {message: 'Does anyone know what our churn was last month?'});
        const reply = await waitFor(async () => ((await owner.api.get(`/posts/${p.id}/thread`)) as Post[]).find((x) => x.props.joinedIn && !x.props.streaming), 15_000, 'Captain joining in');
        assert.match(reply.message, /Churn was 14%/);
        const [run] = await runsFor(generalId, p.id);
        assert.equal(run.rootPostId, p.id);

        // Right after, it doesn't join in again in the same chat.
        const q: Post = await owner.api.post(`/channels/${generalId}/posts`, {message: 'And what about signups, does anyone know?'});
        await settle();
        assert.equal((await runsFor(generalId, q.id)).length, 0);
    });

    it('stays out of small talk, messages to people, and chats that turned it off', async () => {
        config.agents.joinInCooldownMs = 0;
        const room = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Launch room', type: 'O'});
        const say = async (message: string) => {
            const p: Post = await owner.api.post(`/channels/${room.id}/posts`, {message});
            await settle(1800); // one at a time: a newer message makes Captain skip the older one
            return p;
        };
        const quiet = [await say('thanks!'), await say('Lunch at noon tomorrow, everyone.'), await say('@grace can you check the deck before Friday?')];
        const updated = await owner.api.patch(`/channels/${room.id}`, {captainJoinsIn: false});
        assert.equal(updated.captainJoinsIn, false);
        quiet.push(await owner.api.post(`/channels/${room.id}/posts`, {message: 'What should our launch-day target be?'}));
        await settle();
        for (const p of quiet) {
            assert.equal((await runsFor(room.id, p.id)).length, 0, p.message);
        }
        const asked = llm.requests.filter((r) => systemText(r).includes('ROLE: JOIN-IN')).map((r) => String(r.messages.at(-1)!.content));
        assert.ok(asked.some((t) => t.includes('Lunch at noon')), 'a plain statement is looked at (and declined)');
        assert.ok(!asked.some((t) => /thanks!|can you check the deck|launch-day target/.test(t.split('\n').at(-1)!)), 'small talk, @people and a chat that turned it off aren\'t sent to the model');

        // Turned back on, it can join in again.
        await owner.api.patch(`/channels/${room.id}`, {captainJoinsIn: true});
        const p: Post = await owner.api.post(`/channels/${room.id}/posts`, {message: 'Which day should we launch on, any idea?'});
        await waitFor(async () => ((await owner.api.get(`/posts/${p.id}/thread`)) as Post[]).find((x) => x.props.joinedIn && !x.props.streaming), 15_000, 'Captain joining in again');
    });

    it('a direct message can\'t turn it off', async () => {
        const captain = (await owner.api.get(`/workspaces/${wsId}/agents`)).agents.find((a: {isCoordinator: boolean}) => a.isCoordinator);
        const dm = await owner.api.post(`/workspaces/${wsId}/dms`, {userId: captain.userId});
        await assert.rejects(owner.api.patch(`/channels/${dm.id}`, {captainJoinsIn: false}));
    });

    it('in a private chat that\'s just you and agents, they answer without an @, in the conversation', async () => {
        const agents: {userId: string; handle: string; isCoordinator: boolean}[] = (await owner.api.get(`/workspaces/${wsId}/agents`)).agents;
        const writer = agents.find((a) => a.handle === 'writer')!;
        const analyst = agents.find((a) => a.handle === 'analyst')!;

        // One agent: it answers itself.
        const solo = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Drafts', type: 'P'});
        await owner.api.post(`/channels/${solo.id}/members`, {userIds: [writer.userId]});
        const p: Post = await owner.api.post(`/channels/${solo.id}/posts`, {message: 'draft a two-line launch teaser'});
        const [run] = await waitFor(async () => {
            const runs = await runsFor(solo.id, p.id);
            return runs.length ? runs : null;
        }, 15_000, 'Writer answering');
        assert.equal(run.rootPostId, null, 'answered in the conversation, not a thread');
        const reply = await waitFor(async () => ((await owner.api.get(`/channels/${solo.id}/posts`)) as Post[]).find((x) => x.userId === writer.userId && !x.props.streaming), 15_000, 'the reply');
        assert.equal((reply as Post & {rootId: string | null}).rootId ?? null, null);

        // Several agents: Captain takes it, working with just them.
        const pair = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Numbers', type: 'P'});
        await owner.api.post(`/channels/${pair.id}/members`, {userIds: [writer.userId, analyst.userId]});
        const q: Post = await owner.api.post(`/channels/${pair.id}/posts`, {message: 'what should our launch target be'});
        const captain = agents.find((a) => a.isCoordinator)!;
        const led = await waitFor(async () => ((await owner.api.get(`/channels/${pair.id}/posts`)) as (Post & {rootId: string | null})[]).find((x) => x.userId === captain.userId && !x.props.streaming), 15_000, 'Captain taking it');
        assert.equal(led.rootId, null);
        assert.equal((await runsFor(pair.id, q.id)).length, 1, 'one run, led by Captain');

        // With another person in the chat, it's @ again (and Captain joining in).
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        const mia = await signup(s.base, {name: 'Mia', invite: invite.token});
        await owner.api.post(`/channels/${solo.id}/members`, {userIds: [(await mia.api.get('/users/me')).id]});
        const r: Post = await owner.api.post(`/channels/${solo.id}/posts`, {message: 'Mia, lunch at noon tomorrow'});
        await settle();
        assert.equal((await runsFor(solo.id, r.id)).length, 0);
    });
});
