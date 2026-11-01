import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {client, expectStatus, signup, socket, startServer, type TestServer, waitFor} from './helpers.js';

describe('chat', () => {
    let s: TestServer;
    let owner: Awaited<ReturnType<typeof signup>>;
    let member: Awaited<ReturnType<typeof signup>>;
    let outsider: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;

    before(async () => {
        s = await startServer();
        owner = await signup(s.base, {name: 'Olive Owner', workspaceName: 'Chat'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        member = await signup(s.base, {name: 'Max Member', invite: invite.token});
        outsider = await signup(s.base, {name: 'Otto Outsider', workspaceName: 'Elsewhere'});
        const {channels} = await owner.api.get(`/workspaces/${wsId}/channels`);
        generalId = channels[0].id;
    });
    after(async () => {
        await s.stop();
    });

    it('posts, threads, edits and deletes with the right permissions', async () => {
        const root = await owner.api.post(`/channels/${generalId}/posts`, {message: 'Kickoff at 10', pendingId: 'p-1'});
        assert.equal(root.pendingId, 'p-1');
        const reply = await member.api.post(`/channels/${generalId}/posts`, {message: 'See you there', rootId: root.id});
        await expectStatus(member.api.post(`/channels/${generalId}/posts`, {message: 'nested', rootId: reply.id}), 400);

        const thread = await owner.api.get(`/posts/${root.id}/thread`);
        assert.deepEqual(thread.map((p: {message: string}) => p.message), ['Kickoff at 10', 'See you there']);
        assert.equal((await owner.api.get(`/posts/${root.id}`)).replyCount, 1);

        await expectStatus(member.api.patch(`/posts/${root.id}`, {message: 'hijack'}), 403);
        const edited = await owner.api.patch(`/posts/${root.id}`, {message: 'Kickoff at 11'});
        assert.ok(edited.editedAt);

        await expectStatus(member.api.del(`/posts/${root.id}`), 403);
        await owner.api.del(`/posts/${reply.id}`); // admins can remove others' messages
        assert.equal((await owner.api.get(`/posts/${root.id}`)).replyCount, 0);
        await expectStatus(outsider.api.get(`/posts/${root.id}`), 404);
        await expectStatus(owner.api.post(`/channels/${generalId}/posts`, {message: '   '}), 400);
    });

    it('keeps private channels and DMs private', async () => {
        const secret = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Secret Plans', type: 'P'});
        assert.equal(secret.name, 'secret-plans');
        await owner.api.post(`/channels/${secret.id}/posts`, {message: 'the password is swordfish'});
        await expectStatus(member.api.get(`/channels/${secret.id}/posts`), 404);
        await expectStatus(member.api.post(`/channels/${secret.id}/join`), 404);
        const hits = await member.api.get(`/workspaces/${wsId}/search?q=swordfish`);
        assert.equal(hits.length, 0);
        assert.equal((await owner.api.get(`/workspaces/${wsId}/search?q=swordf`)).length, 1);

        const dm = await member.api.post(`/workspaces/${wsId}/dms`, {userId: owner.session.user.id});
        const same = await owner.api.post(`/workspaces/${wsId}/dms`, {userId: member.session.user.id});
        assert.equal(dm.id, same.id);
        assert.equal(dm.type, 'D');
        await expectStatus(member.api.post(`/workspaces/${wsId}/dms`, {userId: outsider.session.user.id}), 404);
    });

    it('public channels: browse, join, leave', async () => {
        const ch = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Design', purpose: 'Pixels'});
        const browse = await member.api.get(`/workspaces/${wsId}/channels/browse`);
        assert.ok(browse.some((c: {id: string}) => c.id === ch.id));
        await expectStatus(member.api.get(`/channels/${ch.id}/posts`), 403);
        await member.api.post(`/channels/${ch.id}/join`);
        await member.api.post(`/channels/${ch.id}/posts`, {message: 'hi design'});
        await member.api.post(`/channels/${ch.id}/leave`);
        await expectStatus(member.api.get(`/channels/${ch.id}/posts`), 403);
    });

    it('counts unread messages and mentions', async () => {
        const ch = await owner.api.post(`/workspaces/${wsId}/channels`, {displayName: 'Counts', memberIds: [member.session.user.id]});
        await owner.api.post(`/channels/${ch.id}/posts`, {message: 'one'});
        await owner.api.post(`/channels/${ch.id}/posts`, {message: `two @${member.session.user.username}`});
        const mine = await member.api.get(`/workspaces/${wsId}/channels`);
        const channel = mine.channels.find((c: {id: string}) => c.id === ch.id);
        const m = mine.members.find((x: {channelId: string}) => x.channelId === ch.id);
        assert.equal(channel.totalMsgCount - m.msgCount, 2);
        assert.equal(m.mentionCount, 1);
        await member.api.post(`/channels/${ch.id}/view`);
        const after = (await member.api.get(`/workspaces/${wsId}/channels`)).members.find((x: {channelId: string}) => x.channelId === ch.id);
        assert.equal(after.mentionCount, 0);
        assert.equal(after.msgCount, channel.totalMsgCount);
    });

    it('reactions', async () => {
        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: 'react to me'});
        await member.api.post(`/posts/${p.id}/reactions`, {emoji: 'celebrate'});
        await owner.api.post(`/posts/${p.id}/reactions`, {emoji: '🎉'}); // Unicode from before: stored as its Crew id
        await expectStatus(owner.api.post(`/posts/${p.id}/reactions`, {emoji: '🦄'}), 400);
        let post = await owner.api.get(`/posts/${p.id}`);
        assert.deepEqual(post.reactions, [{emoji: 'celebrate', userIds: [member.session.user.id, owner.session.user.id]}]);
        await member.api.del(`/posts/${p.id}/reactions/${encodeURIComponent('🎉')}`);
        post = await owner.api.get(`/posts/${p.id}`);
        assert.deepEqual(post.reactions[0].userIds, [owner.session.user.id]);
    });

    it('uploads files and serves them from signed links', async () => {
        const form = new FormData();
        form.append('file', new Blob(['hello file'], {type: 'text/plain'}), 'note.txt');
        const res = await fetch(`${s.base}/api/v1/channels/${generalId}/files`, {method: 'POST', headers: {Authorization: `Bearer ${owner.session.token}`}, body: form});
        assert.equal(res.status, 200);
        const info = (await res.json()) as {id: string; name: string};
        assert.equal(info.name, 'note.txt');

        // Someone else can't attach your upload.
        await expectStatus(member.api.post(`/channels/${generalId}/posts`, {message: 'mine now', fileIds: [info.id]}), 400);
        const post = await owner.api.post(`/channels/${generalId}/posts`, {message: 'see attached', fileIds: [info.id]});
        assert.equal(post.files[0].id, info.id);
        // Attached once only.
        await expectStatus(owner.api.post(`/channels/${generalId}/posts`, {message: 'again', fileIds: [info.id]}), 400);

        const ok = await fetch(`${s.base}${post.files[0].url}`);
        assert.equal(ok.status, 200);
        assert.equal(await ok.text(), 'hello file');
        assert.match(ok.headers.get('content-security-policy') ?? '', /sandbox/);
        const tampered = await fetch(`${s.base}${post.files[0].url.replace(/sig=(.)/, (_m: string, c: string) => `sig=${c === 'x' ? 'y' : 'x'}`)}`);
        assert.equal(tampered.status, 404);
    });

    it('delivers events over the socket and replays missed ones after a reconnect', async () => {
        const live = await socket(s.base, member.session.token);
        const hello = live.events.find((e) => e.event === 'hello')!;
        const connectionId = (hello.data as {connectionId: string}).connectionId;

        const p = await owner.api.post(`/channels/${generalId}/posts`, {message: 'realtime!'});
        const posted = await waitFor(async () => live.events.find((e) => e.event === 'posted' && (e.data as {post: {id: string}}).post.id === p.id), 3000, 'posted');
        const lastSeq = posted.seq;
        live.close();
        await new Promise((r) => setTimeout(r, 200));

        // Two messages while disconnected.
        await owner.api.post(`/channels/${generalId}/posts`, {message: 'missed one'});
        await owner.api.post(`/channels/${generalId}/posts`, {message: 'missed two'});

        const back = await socket(s.base, member.session.token, {connectionId, lastSeq});
        const hello2 = back.events.find((e) => e.event === 'hello')!;
        assert.equal((hello2.data as {replayed: boolean}).replayed, true);
        const missed = await waitFor(async () => {
            const got = back.events.filter((e) => e.event === 'posted').map((e) => (e.data as {post: {message: string}}).post.message);
            return got.length >= 2 ? got : null;
        }, 3000, 'replay');
        assert.deepEqual(missed, ['missed one', 'missed two']);
        back.close();

        // A bad token is refused.
        const ws = await import('ws');
        const bad = new ws.default(`${s.base.replace('http', 'ws')}/api/v1/websocket`);
        await new Promise((r) => bad.once('open', r));
        bad.send(JSON.stringify({action: 'auth', seq: 1, token: 'nope'}));
        const code = await new Promise((r) => bad.once('close', (c) => r(c)));
        assert.equal(code, 4001);
    });

    it('serves health checks without a session', async () => {
        const r = await fetch(`${s.base}/readyz`);
        assert.equal(r.status, 200);
        assert.equal((await client(s.base).get('/config')).demoMode, true);
    });
});
