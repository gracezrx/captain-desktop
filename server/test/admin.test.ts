// Model keys pasted in Settings: who may set them, that they're stored
// encrypted, that the router uses them (over the environment), that every
// instance picks them up, and the key check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

import postgres from 'postgres';

import {boot, type Instance} from '../src/boot.js';
import {config} from '../src/config.js';
import {connectionOptions} from '../src/db/index.js';
import {migrate} from '../src/db/migrate.js';
import {Catalog} from '../src/llm/catalog.js';
import {decryptSecret, encryptSecret} from '../src/util/crypto.js';

import {client, expectStatus, fakeProvider, type FakeRequest, model, signup, startServer, TEST_DB, type TestServer, waitFor} from './helpers.js';

type Provider = {id: string; source: string | null; last4: string | null; unreadable: boolean; needsBaseUrl: boolean; baseUrl: string | null; models: number; recommended: boolean};

describe('model keys in Settings', () => {
    let s: TestServer;
    let llm: Awaited<ReturnType<typeof fakeProvider>>;
    let reject = false;
    let first: Awaited<ReturnType<typeof signup>>;
    let second: Awaited<ReturnType<typeof signup>>;
    const catalog = () => new Catalog({
        providers: {
            openrouter: {label: 'OpenRouter', baseUrl: '', apiKeyEnv: 'TEST_ADMIN_OR_KEY'},
            gw: {label: 'Gateway', baseUrlEnv: 'TEST_ADMIN_GW_URL', apiKeyEnv: 'TEST_ADMIN_GW_KEY'},
        },
        models: [model('cheap', 'easy', 1, [['openrouter', 'vendor/cheap'], ['gw', 'cheap']]), model('smart', 'hard', 1, [['openrouter', 'vendor/smart']])],
    });

    before(async () => {
        llm = await fakeProvider((_req: FakeRequest) => (reject ? {status: 401} : {text: 'OK'}));
        delete process.env.TEST_ADMIN_OR_KEY;
        const c = catalog();
        c.providers.openrouter.baseUrl = llm.url;
        s = await startServer({catalog: c});
        first = await signup(s.base, {name: 'Runner', workspaceName: 'Keys'});
        second = await signup(s.base, {name: 'Other', workspaceName: 'Elsewhere'});
    });
    after(async () => {
        delete process.env.TEST_ADMIN_OR_KEY;
        await s.stop();
        await llm.close();
    });

    it('makes the first person to sign up the server admin, and only them', async () => {
        assert.equal((await first.api.get('/users/me')).instanceAdmin, true);
        assert.equal(first.session.user.instanceAdmin, true);
        assert.equal((await second.api.get('/users/me')).instanceAdmin, undefined);
        await expectStatus(second.api.get('/admin/providers'), 403);
        await expectStatus(second.api.put('/admin/providers/openrouter', {apiKey: 'sk-or-v1-stolen-key'}), 403);
        await expectStatus(client(s.base).get('/admin/providers'), 401);
    });

    it('also lets the people named in INSTANCE_ADMINS run the server', async () => {
        const email = (await second.api.get('/users/me')).email as string;
        config.instanceAdmins.push(email);
        try {
            assert.equal((await second.api.get('/users/me')).instanceAdmin, true);
            assert.ok((await second.api.get('/admin/providers')).length > 0);
        } finally {
            config.instanceAdmins.length = 0;
        }
        await expectStatus(second.api.get('/admin/providers'), 403);
    });

    it('with INSTANCE_ADMINS set, only the people it lists run the server', async () => {
        config.instanceAdmins.push('someone-else@example.com');
        try {
            assert.equal((await first.api.get('/users/me')).instanceAdmin, undefined, 'the first sign-up no longer counts');
            await expectStatus(first.api.get('/admin/providers'), 403);
        } finally {
            config.instanceAdmins.length = 0;
        }
    });

    it('doesn\'t let a workspace owner take over the server admin\'s account, or anyone else\'s', async () => {
        // A stranger makes a workspace and invites the person who runs the server.
        const [{id: strangerWs}] = await second.api.get('/workspaces');
        const invite = await second.api.post(`/workspaces/${strangerWs}/invites`, {});
        await first.api.post(`/invites/${invite.token}/accept`, {});
        const members = await second.api.get(`/workspaces/${strangerWs}/members`);
        assert.ok(members.users.every((u: {instanceAdmin?: boolean}) => u.instanceAdmin === undefined), 'not shown to other people');
        const err = await expectStatus(second.api.post(`/workspaces/${strangerWs}/members/${first.session.user.id}/reset-link`), 403);
        assert.match(err.body.message!, /runs the server/);

        // Nor anyone who is also in another workspace.
        const third = await signup(s.base, {name: 'Third', workspaceName: 'Third\'s own'});
        const invite2 = await second.api.post(`/workspaces/${strangerWs}/invites`, {});
        await third.api.post(`/invites/${invite2.token}/accept`, {});
        const err2 = await expectStatus(second.api.post(`/workspaces/${strangerWs}/members/${third.session.user.id}/reset-link`), 403);
        assert.match(err2.body.message!, /other workspaces/);
    });

    it('ignores provider names that aren\'t providers', async () => {
        await expectStatus(first.api.put('/admin/providers/__proto__', {apiKey: 'sk-long-enough-key'}), 404);
        await expectStatus(first.api.put('/admin/providers/constructor', {apiKey: 'sk-long-enough-key'}), 404);
    });

    it('starts in demo mode and lists OpenRouter first', async () => {
        assert.equal((await client(s.base).get('/config')).demoMode, true);
        const list = await first.api.get<Provider[]>('/admin/providers');
        assert.equal(list[0].id, 'openrouter');
        assert.equal(list[0].recommended, true);
        assert.equal(list[0].source, null);
        assert.equal(list[0].models, 2);
        assert.equal(list.find((p) => p.id === 'gw')!.needsBaseUrl, true);
    });

    it('saves a key encrypted, uses it right away, and checks it', async () => {
        const {provider: saved, check: tried} = await first.api.put<{provider: Provider; check: {ok: boolean}}>('/admin/providers/openrouter', {apiKey: '  sk-or-v1-secret-abcd  '});
        assert.equal(tried.ok, true, 'saving tries the key');
        assert.equal(saved.source, 'settings');
        assert.equal(saved.last4, 'abcd');
        assert.equal((await client(s.base).get('/config')).demoMode, false);

        const [row] = await s.instance.ctx.sql`select secret from provider_keys where provider_id = 'openrouter'`;
        assert.ok(!String(row.secret).includes('secret-abcd'), 'stored encrypted');
        assert.equal(decryptSecret(String(row.secret)), 'sk-or-v1-secret-abcd');

        const check = await first.api.post('/admin/providers/openrouter/check');
        assert.equal(check.ok, true, check.message);
        assert.equal(check.modelId, 'cheap');
        assert.equal(llm.requests.at(-1)!.auth, 'Bearer sk-or-v1-secret-abcd');

        // Nobody else sees the key, not even its last characters.
        const models = await second.api.get(`/workspaces/${(await second.api.get('/workspaces'))[0].id}/models`).catch(() => null);
        assert.ok(!JSON.stringify(models ?? {}).includes('abcd'));
        const [log] = await s.instance.ctx.sql`select user_id, action from audit_log where action = 'provider_key_saved'`;
        assert.equal(log.userId, first.session.user.id);
    });

    it('prefers the key from Settings over the environment', async () => {
        process.env.TEST_ADMIN_OR_KEY = 'sk-from-env-0000';
        const list = await first.api.get<Provider[]>('/admin/providers');
        assert.equal(list[0].source, 'settings');
        await first.api.post('/admin/providers/openrouter/check');
        assert.equal(llm.requests.at(-1)!.auth, 'Bearer sk-or-v1-secret-abcd');
        delete process.env.TEST_ADMIN_OR_KEY;
    });

    it('explains a rejected key, and doesn\'t save one', async () => {
        reject = true;
        try {
            const check = await first.api.post('/admin/providers/openrouter/check');
            assert.equal(check.ok, false);
            assert.match(check.message, /turned the key down/);
            const err = await expectStatus(first.api.put('/admin/providers/openrouter', {apiKey: 'sk-or-v1-wrong-9999'}), 400);
            assert.match(err.body.message!, /wasn't saved/);
            assert.equal((await first.api.get<Provider[]>('/admin/providers'))[0].last4, 'abcd', 'the old key stays');
        } finally {
            reject = false;
        }
    });

    it('validates input and needs an address for a gateway', async () => {
        await expectStatus(first.api.put('/admin/providers/openrouter', {apiKey: 'short'}), 400);
        await expectStatus(first.api.put('/admin/providers/openrouter', {apiKey: 'has a space in it'}), 400);
        await expectStatus(first.api.put('/admin/providers/nope', {apiKey: 'sk-long-enough-key'}), 404);
        await expectStatus(first.api.put('/admin/providers/gw', {apiKey: 'gw-key-123456'}), 400);
        await expectStatus(first.api.put('/admin/providers/gw', {apiKey: 'gw-key-123456', baseUrl: 'ftp://x'}), 400);
        const {provider: gw} = await first.api.put<{provider: Provider}>('/admin/providers/gw', {apiKey: 'gw-key-123456', baseUrl: `${llm.url}/`});
        assert.equal(gw.baseUrl, llm.url);
        assert.equal((await first.api.post('/admin/providers/gw/check')).ok, true);
        await first.api.del('/admin/providers/gw');
    });

    it('reaches every instance, and removing the key goes back to demo mode', async () => {
        const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-files-'));
        const c = catalog();
        c.providers.openrouter.baseUrl = llm.url;
        const other: Instance = await boot({databaseUrl: TEST_DB, filesDir, catalog: c, workers: false});
        try {
            assert.equal(other.ctx.router.demoMode, false, 'loads saved keys at start');
            await first.api.del('/admin/providers/openrouter');
            await waitFor(async () => other.ctx.router.demoMode, 5000, 'the other instance to drop the key');
            assert.equal((await client(s.base).get('/config')).demoMode, true);
            await first.api.put('/admin/providers/openrouter', {apiKey: 'sk-or-v1-second-wxyz'});
            await waitFor(async () => !other.ctx.router.demoMode, 5000, 'the other instance to load the key');
            assert.equal(other.ctx.router.catalog.endpoint('openrouter')!.apiKey, 'sk-or-v1-second-wxyz');
        } finally {
            await other.stop();
            fs.rmSync(filesDir, {recursive: true, force: true});
        }
    });

    it('can\'t read keys saved under another APP_SECRET', async () => {
        const blob = encryptSecret('sk-test-1234');
        const [v, iv, tag, data] = blob.split(':');
        const flipped = Buffer.from(data, 'base64');
        flipped[0] ^= 1;
        assert.equal(decryptSecret([v, iv, tag, flipped.toString('base64')].join(':')), null);
        assert.equal(decryptSecret('garbage'), null);
        assert.equal(decryptSecret([v, iv, Buffer.from(tag, 'base64').subarray(0, 4).toString('base64'), data].join(':')), null, 'a short tag is refused');

        await s.instance.ctx.sql`update provider_keys set secret = ${'v1:AAAA:AAAA:AAAA'} where provider_id = 'openrouter'`;
        await s.instance.ctx.keys.load();
        const list = await first.api.get<Provider[]>('/admin/providers');
        assert.equal(list[0].unreadable, true);
        assert.equal(list[0].source, null);
        assert.equal(s.instance.ctx.router.demoMode, true);
    });

    it('turns on row-level security for every table (Supabase exposes "public")', async () => {
        const sql = postgres(TEST_DB, {max: 1, onnotice: () => undefined});
        try {
            const open = await sql`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`;
            assert.deepEqual(open.map((r) => r.tablename), []);

            // Another app's tables in the same database are left alone, whoever owns them.
            await sql.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'captain_test_other') then create role captain_test_other; end if; end $$`);
            await sql.unsafe('create table public.someone_elses (id int); alter table public.someone_elses owner to captain_test_other');
            await sql.unsafe('create table public.another_app (id int)');
            await migrate(s.instance.ctx.sql);
            const others = await sql`select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename in ('someone_elses', 'another_app')`;
            assert.deepEqual(others.map((r) => r.rowsecurity), [false, false]);
            await sql.unsafe('drop table public.someone_elses; drop table public.another_app');
        } finally {
            await sql.end();
        }
    });
});

describe('database addresses', () => {
    it('uses TLS for hosted Postgres and warns about the transaction pooler', () => {
        const pooler = 'postgres://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
        assert.equal(connectionOptions(pooler).ssl, 'require');
        assert.equal(connectionOptions(pooler).warning, undefined);
        assert.equal(connectionOptions('postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres').ssl, 'require');
        const tx = connectionOptions('postgres://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
        assert.equal(tx.prepare, false);
        assert.match(tx.warning!, /5432/);
        assert.equal(connectionOptions('postgres://postgres@127.0.0.1:5432/captain').ssl, undefined);
        assert.equal(connectionOptions(`${pooler}?sslmode=verify-full`).ssl, undefined, 'an explicit sslmode wins');
    });
});

describe('an invite-only server', () => {
    let s: TestServer;
    const was = config.openSignup;
    before(async () => {
        config.openSignup = false;
        s = await startServer();
    });
    after(async () => {
        config.openSignup = was;
        await s.stop();
    });

    it('lets the first person sign up to set it up, then needs invites', async () => {
        assert.equal((await client(s.base).get('/config')).openSignup, true);
        const owner = await signup(s.base, {name: 'Setup', workspaceName: 'Home'});
        assert.equal(owner.session.user.instanceAdmin, true);
        assert.equal((await client(s.base).get('/config')).openSignup, false);
        await expectStatus(signup(s.base, {name: 'Stranger', workspaceName: 'Theirs'}), 403);
        const [{id}] = await owner.api.get('/workspaces');
        const invite = await owner.api.post(`/workspaces/${id}/invites`, {});
        const guest = await signup(s.base, {name: 'Invited', invite: invite.token});
        assert.equal(guest.session.user.instanceAdmin, undefined);
    });
});
