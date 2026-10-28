#!/usr/bin/env node
// One-time setup for a fresh Mattermost: creates the admin account, the
// team, a few channels and the agent bots, adds the bots to the team, and
// writes the bots' access tokens to .env for the bridge. Safe to run again:
// anything that exists is reused (tokens are only minted when missing).
//
// Usage: node setup.mjs   (reads .env next to this file)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(DIR, '.env');

function readEnv() {
    const out = {};
    if (!fs.existsSync(ENV_FILE)) {
        console.error('No .env found. Copy .env.example to .env and fill it in first.');
        process.exit(1);
    }
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) {
            out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
    return {...out, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k in out))};
}

function writeEnvValue(key, value) {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    const line = `${key}=${value}`;
    const next = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
    fs.writeFileSync(ENV_FILE, next, {mode: 0o600});
}

const env = readEnv();
const BASE = (process.env.MM_URL || env.MM_SITE_URL || 'http://localhost:8065').replace(/\/+$/, '');
let token = '';

async function api(method, p, body, {allow404 = false} = {}) {
    const res = await fetch(`${BASE}/api/v4${p}`, {
        method,
        headers: {'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(token ? {Authorization: `Bearer ${token}`} : {})},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) {
        return null;
    }
    if (!res.ok) {
        throw new Error(`${method} ${p} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return {data: await res.json().catch(() => ({})), headers: res.headers};
}

async function waitForServer() {
    process.stdout.write(`Waiting for Mattermost at ${BASE} `);
    for (let i = 0; i < 90; i++) {
        try {
            const r = await fetch(`${BASE}/api/v4/system/ping`);
            if (r.ok) {
                console.log('ready');
                return;
            }
        } catch {
            // not up yet
        }
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Mattermost did not start in 3 minutes. Check: docker compose logs mattermost');
}

const AGENTS = [
    {username: 'captain', display_name: 'Captain', description: 'Routes work to the right model and coordinates the team'},
    {username: 'researcher', display_name: 'Researcher', description: 'Finds and checks facts and sources'},
    {username: 'designer', display_name: 'Designer', description: 'Drafts UI, visuals and copy'},
];
const CHANNELS = [
    {name: 'launch-room', display_name: 'Launch room', type: 'O', purpose: 'Launch planning with the team and agents'},
    {name: 'design-review', display_name: 'Design review', type: 'P', purpose: 'Screens, snapshots and feedback'},
];

async function main() {
    for (const k of ['ADMIN_EMAIL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD']) {
        if (!env[k]) {
            throw new Error(`Set ${k} in .env`);
        }
    }
    await waitForServer();

    // 1. Admin: the first account on a new server becomes the system admin.
    let login = await fetch(`${BASE}/api/v4/users/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({login_id: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD})});
    if (!login.ok) {
        console.log(`Creating admin ${env.ADMIN_USERNAME}`);
        await api('POST', '/users', {email: env.ADMIN_EMAIL, username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD});
        login = await fetch(`${BASE}/api/v4/users/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({login_id: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD})});
        if (!login.ok) {
            throw new Error(`Couldn't sign in as ${env.ADMIN_USERNAME}: ${await login.text()}`);
        }
    }
    token = login.headers.get('Token');
    const admin = await login.json();

    // 2. Team
    const teamName = env.TEAM_NAME || 'captain';
    let team = (await api('GET', `/teams/name/${teamName}`, undefined, {allow404: true}))?.data;
    if (!team) {
        console.log(`Creating team ${teamName}`);
        team = (await api('POST', '/teams', {name: teamName, display_name: env.TEAM_DISPLAY_NAME || 'Captain', type: 'I'})).data;
    }
    await api('POST', `/teams/${team.id}/members`, {team_id: team.id, user_id: admin.id}).catch(() => undefined);

    // 3. Channels
    const channels = [];
    for (const c of CHANNELS) {
        let ch = (await api('GET', `/teams/${team.id}/channels/name/${c.name}`, undefined, {allow404: true}))?.data;
        if (!ch) {
            console.log(`Creating channel ${c.display_name}`);
            ch = (await api('POST', '/channels', {team_id: team.id, ...c})).data;
        }
        channels.push(ch);
    }

    // 4. Agent bots, in the team and in every channel, each with a token.
    const existing = Object.fromEntries((env.AGENT_TOKENS || '').split(',').filter(Boolean).map((p) => p.split('=')));
    const tokens = {};
    for (const a of AGENTS) {
        let user = (await api('GET', `/users/username/${a.username}`, undefined, {allow404: true}))?.data;
        if (!user) {
            console.log(`Creating agent bot @${a.username}`);
            const bot = (await api('POST', '/bots', a)).data;
            user = {id: bot.user_id};
        }
        await api('POST', `/teams/${team.id}/members`, {team_id: team.id, user_id: user.id}).catch(() => undefined);
        for (const ch of channels) {
            await api('POST', `/channels/${ch.id}/members`, {user_id: user.id}).catch(() => undefined);
        }
        tokens[a.username] = existing[a.username] || (await api('POST', `/users/${user.id}/tokens`, {description: 'Captain bridge'})).data.token;
    }
    writeEnvValue('AGENT_TOKENS', Object.entries(tokens).map(([u, t]) => `${u}=${t}`).join(','));

    console.log('\nDone.');
    console.log(`  Workspace: ${team.display_name} (${BASE})`);
    console.log(`  Sign in to the desktop app as ${env.ADMIN_USERNAME} with the password from .env`);
    console.log(`  Agents: ${AGENTS.map((a) => '@' + a.username).join(', ')} (tokens saved to .env)`);
}

main().catch((e) => {
    console.error(`\nSetup failed: ${e.message}`);
    process.exit(1);
});
