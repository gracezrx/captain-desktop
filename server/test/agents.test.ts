// Multi-agent orchestration end to end, with the built-in demo model.

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {expectStatus, signup, startServer, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; userId: string; rootId: string | null; props: Record<string, any>; files: {name: string; url: string}[]};
type Run = {id: string; status: string; kind: string; rootPostId: string | null; steps: {id: string; status: string; agentId: string}[]};

describe('agents and orchestration (demo model)', () => {
    let s: TestServer;
    let owner: Awaited<ReturnType<typeof signup>>;
    let member: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;
    let agents: {id: string; handle: string; userId: string}[];

    const runFor = (api: typeof owner.api, channelId: string, rootPostId: string | null, triggerId?: string) =>
        waitFor(async () => {
            const runs: Run[] = await api.get(`/channels/${channelId}/runs`);
            return runs.find((r) => (triggerId ? true : r.rootPostId === rootPostId) && ['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(r.status));
        }, 20_000, 'run to settle');

    before(async () => {
        s = await startServer();
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Agents'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        member = await signup(s.base, {name: 'Mia', invite: invite.token});
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
        agents = (await owner.api.get(`/workspaces/${wsId}/agents`)).agents;
    });
    after(async () => {
        await s.stop();
    });

    it('an @mention gets an answer in the thread, with model attribution', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@researcher what is our refund policy?'});
        const run = await runFor(owner.api, generalId, p.id);
        assert.equal(run.status, 'succeeded');
        assert.equal(run.kind, 'single');
        const thread: Post[] = await owner.api.get(`/posts/${p.id}/thread`);
        assert.equal(thread.length, 2);
        const answer = thread[1];
        assert.equal(answer.userId, agents.find((a) => a.handle === 'researcher')!.userId);
        assert.equal(answer.props.streaming, false);
        assert.equal(answer.props.model.id, 'demo');
        assert.match(answer.message, /Demo mode/);
    });

    it('@captain plans bigger work, runs steps by dependency, and combines the results', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@captain research the market and draft a launch plan for our app, then compare pricing'});
        const run = await runFor(owner.api, generalId, p.id);
        assert.equal(run.status, 'succeeded');
        assert.equal(run.kind, 'plan');
        assert.deepEqual(run.steps.map((x) => x.status), ['succeeded', 'succeeded', 'succeeded']);
        const thread: Post[] = await owner.api.get(`/posts/${p.id}/thread`);
        const card = thread.find((x) => x.type === 'plan')!;
        assert.equal(card.props.plan.status, 'succeeded');
        assert.ok(card.props.plan.steps.every((x: {postId: string | null}) => x.postId));
        const stepPosts = thread.filter((x) => x.type === 'agent_step');
        assert.equal(stepPosts.length, 3);
        const handles = stepPosts.map((x) => agents.find((a) => a.userId === x.userId)!.handle);
        assert.deepEqual(handles, ['researcher', 'analyst', 'writer']);
        const final = thread.at(-1)!;
        assert.equal(final.userId, agents.find((a) => a.handle === 'captain')!.userId);
        assert.match(final.message, /where the team landed/);
        // Later steps saw earlier steps' output.
        const detail: {steps: {output: string}[]} = await owner.api.get(`/runs/${run.id}`);
        assert.ok(detail.steps.every((x) => x.output));
    });

    it('naming several agents gets one coordinated run: Captain splits the work between just them', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@researcher @writer research our competitors and draft a launch note'});
        const run = await runFor(owner.api, generalId, p.id);
        assert.equal(run.status, 'succeeded');
        assert.equal(run.kind, 'plan');
        const runs: Run[] = await owner.api.get(`/channels/${generalId}/runs`);
        assert.equal(runs.filter((r) => r.rootPostId === p.id).length, 1, 'one run, not one per agent');
        const byId = (id: string) => agents.find((a) => a.id === id)!.handle;
        assert.deepEqual([...new Set(run.steps.map((st) => byId(st.agentId)))].sort(), ['researcher', 'writer']);
        const thread: Post[] = await owner.api.get(`/posts/${p.id}/thread`);
        const card = thread.find((x) => x.type === 'plan')!;
        assert.deepEqual(card.props.plan.coordinating.map(byId).sort(), ['researcher', 'writer']);
        assert.equal(thread.at(-1)!.userId, agents.find((a) => a.handle === 'captain')!.userId, 'Captain posts the one answer');
    });

    it('naming agents in your DM with Captain makes Captain work with just them', async () => {
        const captain = agents.find((a) => a.handle === 'captain')!;
        const dm = await owner.api.post(`/workspaces/${wsId}/dms`, {userId: captain.userId});
        const p = await owner.api.post(`/channels/${dm.id}/posts`, {message: '@analyst @designer look at our signup funnel and suggest a better first screen'});
        const run = await waitFor(async () => {
            const runs: (Run & {id: string})[] = await owner.api.get(`/channels/${dm.id}/runs`);
            return runs.find((r) => ['succeeded', 'failed'].includes(r.status));
        }, 20_000, 'DM run');
        assert.equal(run.kind, 'plan');
        const handles = [...new Set(run.steps.map((st) => agents.find((a) => a.id === st.agentId)!.handle))].sort();
        assert.deepEqual(handles, ['analyst', 'designer']);
        assert.ok(p.id);
    });

    it('a short request to several named agents still goes to each of them', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@analyst @designer thoughts?'});
        const run = await runFor(owner.api, generalId, p.id);
        assert.equal(run.kind, 'plan');
        const handles = run.steps.map((st) => agents.find((a) => a.id === st.agentId)!.handle).sort();
        assert.deepEqual(handles, ['analyst', 'designer']);
    });

    it('small talk to @captain is answered directly, without a plan', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@captain hello!'});
        const run = await runFor(owner.api, generalId, p.id);
        assert.equal(run.kind, 'single');
        assert.equal(run.status, 'succeeded');
    });

    it('pauses for approval; only the requester or an admin can decide; approval resumes the work', async () => {
        const p = await member.api.post(`/channels/${generalId}/posts`, {message: '@writer email the team that the beta is live'});
        const run = await runFor(member.api, generalId, p.id);
        assert.equal(run.status, 'waiting_approval');
        let thread: Post[] = await member.api.get(`/posts/${p.id}/thread`);
        const card = thread.find((x) => x.type === 'decision')!;
        assert.equal(card.props.decision.status, 'pending');
        assert.equal(card.props.decision.tool, 'send_email');
        assert.ok(card.props.decision.fields.some((f: {label: string}) => f.label === 'To'));

        const pending = await member.api.get(`/workspaces/${wsId}/approvals`);
        assert.equal(pending.length, 1);

        await expectStatus(member.api.post(`/posts/${card.id}/actions/launch`), 400);
        // A third person who is neither the requester nor an admin can't decide.
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        const other = await signup(s.base, {invite: invite.token});
        await expectStatus(other.api.post(`/posts/${card.id}/actions/approve`), 403);

        await member.api.post(`/posts/${card.id}/actions/approve`);
        await expectStatus(owner.api.post(`/posts/${card.id}/actions/reject`), 409);
        const done = await waitFor(async () => {
            const r: Run = await member.api.get(`/runs/${run.id}`);
            return r.status === 'succeeded' ? r : null;
        }, 15_000, 'resume');
        assert.equal(done.status, 'succeeded');
        thread = await member.api.get(`/posts/${p.id}/thread`);
        assert.equal(thread.find((x) => x.type === 'decision')!.props.decision.status, 'approved');
        assert.match(thread.at(-1)!.message, /SMTP_URL|sent/);
    });

    it('a rejection tells the agent not to do it', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@writer send the investors an email about the delay'});
        const run = await runFor(owner.api, generalId, p.id);
        assert.equal(run.status, 'waiting_approval');
        const card = (await owner.api.get(`/posts/${p.id}/thread`) as Post[]).find((x) => x.type === 'decision')!;
        await owner.api.post(`/posts/${card.id}/actions/reject`);
        await waitFor(async () => ((await owner.api.get(`/runs/${run.id}`)) as Run).status === 'succeeded', 15_000, 'resume');
        const thread: Post[] = await owner.api.get(`/posts/${p.id}/thread`);
        assert.match(thread.at(-1)!.message, /won't do that/);
    });

    it('cancelling a waiting run expires its approval', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@writer publish the announcement to our customers'});
        const run = await runFor(owner.api, generalId, p.id);
        assert.equal(run.status, 'waiting_approval');
        await expectStatus(member.api.post(`/runs/${run.id}/cancel`), 403);
        const cancelled: Run = await owner.api.post(`/runs/${run.id}/cancel`);
        assert.equal(cancelled.status, 'cancelled');
        const card = (await owner.api.get(`/posts/${p.id}/thread`) as Post[]).find((x) => x.type === 'decision')!;
        assert.equal(card.props.decision.status, 'expired');
        await expectStatus(owner.api.post(`/posts/${card.id}/actions/approve`), 409);
    });

    it('a direct message to an agent is answered in the conversation, with documents attached', async () => {
        const writer = agents.find((a) => a.handle === 'writer')!;
        const dm = await owner.api.post(`/workspaces/${wsId}/dms`, {userId: writer.userId});
        const p = await owner.api.post(`/channels/${dm.id}/posts`, {message: 'Write a one-pager about our onboarding'});
        const run = await runFor(owner.api, dm.id, null);
        assert.equal(run.status, 'succeeded');
        const posts: Post[] = await owner.api.get(`/channels/${dm.id}/posts`);
        const reply = posts.find((x) => x.userId === writer.userId)!;
        assert.equal(reply.rootId, null);
        assert.equal(reply.files.length, 1);
        assert.match(reply.files[0].name, /\.md$/);
        const doc = await fetch(`${s.base}${reply.files[0].url}`);
        assert.match(await doc.text(), /^# /);
        assert.ok(p.id);
    });

    it('replying in an agent\'s thread continues with that agent', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@designer ideas for the empty state?'});
        await runFor(owner.api, generalId, p.id);
        await owner.api.post(`/channels/${generalId}/posts`, {message: 'make it friendlier', rootId: p.id});
        const runs = await waitFor(async () => {
            const list: Run[] = await owner.api.get(`/channels/${generalId}/runs`);
            const mine = list.filter((r) => r.rootPostId === p.id);
            return mine.length === 2 && mine.every((r) => r.status === 'succeeded') ? mine : null;
        }, 15_000, 'second run');
        assert.equal(runs.length, 2);
        // People talking among themselves in a normal thread don't wake anyone.
        const q = await owner.api.post(`/channels/${generalId}/posts`, {message: 'lunch?'});
        await member.api.post(`/channels/${generalId}/posts`, {message: 'yes', rootId: q.id});
        await new Promise((r) => setTimeout(r, 1500));
        const list: Run[] = await owner.api.get(`/channels/${generalId}/runs`);
        assert.ok(!list.some((r) => r.rootPostId === q.id));
    });

    it('mentioning an agent in a channel it is not in brings it in', async () => {
        const ch = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Ops'});
        const p = await owner.api.post(`/channels/${ch.id}/posts`, {message: '@analyst is this worth it?'});
        const run = await runFor(owner.api, ch.id, p.id);
        assert.equal(run.status, 'succeeded');
        const members: {userId: string}[] = await owner.api.get(`/channels/${ch.id}/members`);
        assert.ok(members.some((m) => m.userId === agents.find((a) => a.handle === 'analyst')!.userId));
    });

    it('admins add and edit agents; members cannot', async () => {
        const body = {handle: 'support', name: 'Support', description: 'Answers customer questions', instructions: 'You answer customer questions kindly and briefly.', tier: 'easy', tools: ['search_workspace'], portrait: 'penguin'};
        await expectStatus(member.api.post(`/workspaces/${wsId}/agents`, body), 403);
        const created = await owner.api.post(`/workspaces/${wsId}/agents`, body);
        assert.equal(created.handle, 'support');
        await expectStatus(owner.api.post(`/workspaces/${wsId}/agents`, body), 409);
        await expectStatus(owner.api.post(`/workspaces/${wsId}/agents`, {...body, handle: 'channel'}), 400);
        await expectStatus(owner.api.post(`/workspaces/${wsId}/agents`, {...body, handle: 'x2', tools: ['rm_rf']}), 400);
        await expectStatus(owner.api.post(`/workspaces/${wsId}/agents`, {...body, handle: 'x3', model: 'gpt-99'}), 400);

        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: '@support hi'});
        assert.equal((await runFor(owner.api, generalId, p.id)).status, 'succeeded');

        const off = await owner.api.patch(`/agents/${created.id}`, {enabled: false, name: 'Helpdesk'});
        assert.equal(off.enabled, false);
        const q = await owner.api.post(`/channels/${generalId}/posts`, {message: '@support are you there?'});
        await new Promise((r) => setTimeout(r, 1500));
        assert.ok(!((await owner.api.get(`/channels/${generalId}/runs`)) as Run[]).some((r) => r.rootPostId === q.id));
        const captain = agents.find((a) => a.handle === 'captain')!;
        await expectStatus(owner.api.patch(`/agents/${captain.id}`, {enabled: false}), 400);
    });

    it('records usage per model and agent', async () => {
        const usage = await owner.api.get(`/workspaces/${wsId}/usage`);
        assert.ok(usage.calls > 5);
        assert.equal(usage.byModel[0].modelId, 'demo');
        assert.ok(usage.byAgent.length >= 3);
    });
});
