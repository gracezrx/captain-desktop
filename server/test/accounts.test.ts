import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {client, expectStatus, signup, startServer, type TestServer} from './helpers.js';

describe('accounts and workspaces', () => {
    let s: TestServer;
    before(async () => {
        s = await startServer();
    });
    after(async () => {
        await s.stop();
    });

    it('signs up, signs in, and signs out', async () => {
        const anon = client(s.base);
        const session = await anon.post('/auth/signup', {email: 'Ada@Example.com', password: 'longenough1', name: 'Ada Lovelace', workspaceName: 'Engines'});
        assert.equal(session.user.email, 'ada@example.com');
        assert.equal(session.user.username, 'ada');
        const me = await client(s.base, session.token).get('/users/me');
        assert.equal(me.displayName, 'Ada Lovelace');

        await expectStatus(anon.post('/auth/login', {login: 'ada@example.com', password: 'wrong-password'}), 401);
        const again = await anon.post('/auth/login', {login: 'ADA@example.com', password: 'longenough1'});
        assert.ok(again.token);

        await client(s.base, again.token).post('/auth/logout');
        await expectStatus(client(s.base, again.token).get('/users/me'), 401);
        // The first session still works.
        await client(s.base, session.token).get('/users/me');
    });

    it('rejects weak input with a readable message', async () => {
        const e = await expectStatus(client(s.base).post('/auth/signup', {email: 'x@example.com', password: 'short', name: 'X'}), 400);
        assert.match(e.body.message ?? '', /at least 8 characters/);
        await expectStatus(client(s.base).post('/auth/signup', {email: 'Ada@example.com', password: 'longenough1', name: 'Dup'}), 409);
    });

    it('requires a session', async () => {
        await expectStatus(client(s.base).get('/workspaces'), 401);
        await expectStatus(client(s.base, 'not-a-token').get('/workspaces'), 401);
    });

    it('creates a workspace with #general and the built-in agents', async () => {
        const {api} = await signup(s.base, {workspaceName: 'Acme'});
        const [ws] = await api.get('/workspaces');
        assert.equal(ws.name, 'Acme');
        assert.equal(ws.role, 'owner');
        const {channels} = await api.get(`/workspaces/${ws.id}/channels`);
        assert.deepEqual(channels.map((c: {name: string}) => c.name), ['general']);
        const {agents, tools} = await api.get(`/workspaces/${ws.id}/agents`);
        assert.deepEqual(agents.map((a: {handle: string}) => a.handle).sort(), ['analyst', 'captain', 'designer', 'researcher', 'writer']);
        assert.ok(tools.some((t: {name: string; external: boolean}) => t.name === 'send_email' && t.external));
    });

    it('invites people with roles, and guests stay out of public channels', async () => {
        const owner = await signup(s.base, {workspaceName: 'Invites'});
        const [ws] = await owner.api.get('/workspaces');
        const memberInvite = await owner.api.post(`/workspaces/${ws.id}/invites`, {role: 'member', maxUses: 1});
        assert.match(memberInvite.url, /\?invite=/);

        const preview = await client(s.base).get(`/invites/${memberInvite.token}`);
        assert.deepEqual(preview, {workspaceName: 'Invites', role: 'member', valid: true});

        const member = await signup(s.base, {invite: memberInvite.token});
        const [joined] = await member.api.get('/workspaces');
        assert.equal(joined.id, ws.id);
        assert.equal(joined.role, 'member');
        const {channels} = await member.api.get(`/workspaces/${ws.id}/channels`);
        assert.equal(channels[0].name, 'general');

        // Used up.
        const third = await signup(s.base);
        await expectStatus(third.api.post(`/invites/${memberInvite.token}/accept`), 400);

        const guestInvite = await owner.api.post(`/workspaces/${ws.id}/invites`, {role: 'guest'});
        const guest = await signup(s.base, {invite: guestInvite.token});
        const guestChannels = await guest.api.get(`/workspaces/${ws.id}/channels`);
        assert.equal(guestChannels.channels.length, 0);
        assert.deepEqual(await guest.api.get(`/workspaces/${ws.id}/channels/browse`), []);
        await expectStatus(guest.api.post(`/workspaces/${ws.id}/channels`, {displayName: 'Nope'}), 403);

        // Members can't invite admins or change roles.
        await expectStatus(member.api.post(`/workspaces/${ws.id}/invites`, {role: 'admin'}), 403);
        await expectStatus(member.api.patch(`/workspaces/${ws.id}/members/${guest.session.user.id}`, {role: 'member'}), 403);
        await owner.api.patch(`/workspaces/${ws.id}/members/${member.session.user.id}`, {role: 'admin'});
        const members = await owner.api.get(`/workspaces/${ws.id}/members`);
        assert.equal(members.members.find((m: {userId: string}) => m.userId === member.session.user.id).role, 'admin');

        // The last owner can't leave.
        await expectStatus(owner.api.del(`/workspaces/${ws.id}/members/${owner.session.user.id}`), 400);
        // Outsiders can't see the workspace at all.
        await expectStatus(third.api.get(`/workspaces/${ws.id}/members`), 404);
    });

    it('only admins see spend and set the budget', async () => {
        const owner = await signup(s.base, {workspaceName: 'Budget'});
        const [ws] = await owner.api.get('/workspaces');
        const updated = await owner.api.patch(`/workspaces/${ws.id}`, {monthlyBudgetUsd: 25});
        assert.equal(updated.monthlyBudgetUsd, 25);
        const usage = await owner.api.get(`/workspaces/${ws.id}/usage`);
        assert.equal(usage.budgetUsd, 25);
        const invite = await owner.api.post(`/workspaces/${ws.id}/invites`, {});
        const member = await signup(s.base, {invite: invite.token});
        await expectStatus(member.api.get(`/workspaces/${ws.id}/usage`), 403);
        await expectStatus(member.api.patch(`/workspaces/${ws.id}`, {monthlyBudgetUsd: 1000}), 403);
        const {demoMode} = await member.api.get(`/workspaces/${ws.id}/models`);
        assert.equal(demoMode, true);
    });
});
