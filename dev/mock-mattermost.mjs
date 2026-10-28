// A small stand-in for a Mattermost server, for UI development only.
//
// It implements the subset of Mattermost's REST API (/api/v4) and WebSocket
// protocol that Captain Desktop uses, with in-memory data and a fake
// "Captain" agent that replies to mentions and posts decision cards.
// Point the app at a real Mattermost server for anything else
// (see dev/docker-compose.yml).
//
// Run: npm run mock   (listens on http://localhost:8065, like Mattermost)
// Sign in as grace / captain.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import busboy from 'busboy';

const PORT = Number(process.env.PORT || 8065);
// --bridge: no built-in fake agent; bots sign in with tokens "bot-<username>"
// so the real Captain bridge (../bridge) can drive them.
const BRIDGE_MODE = process.argv.includes('--bridge') || process.env.MOCK_BRIDGE === '1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, '..', 'desktop', 'public');

const newId = () => crypto.randomBytes(13).toString('hex').slice(0, 26);
const now = () => Date.now();

// ---------------------------------------------------------------- data

const team = {id: 'team0questspace00000000000', name: 'quest-space', display_name: 'Quest Space', type: 'O', create_at: 0, update_at: 0, delete_at: 0};

const users = {};
function addUser(id, username, first, last, extra = {}) {
    users[id] = {
        id, username, first_name: first, last_name: last, nickname: '', email: `${username}@captain.local`,
        position: '', roles: 'system_user', locale: 'en', create_at: 0, update_at: 0, delete_at: 0,
        last_picture_update: 0, is_bot: false, props: {}, notify_props: {}, timezone: {}, ...extra,
    };
}
addUser('user0grace0000000000000000', 'grace', 'Grace', 'Zhong');
addUser('user0sunny0000000000000000', 'sunny', 'Sunny', '');
addUser('user0lisen0000000000000000', 'lisen', 'Lisen', '');
addUser('bot00captain00000000000000', 'captain', 'Captain', '', {is_bot: true, bot_description: 'Routes work to the right model', props: {portrait: 'fox'}});
addUser('bot00researcher00000000000', 'researcher', 'Researcher', '', {is_bot: true, bot_description: 'Finds and checks sources', props: {portrait: 'owl'}});
addUser('bot00designer0000000000000', 'designer', 'Designer', '', {is_bot: true, bot_description: 'Drafts UI and visuals', props: {portrait: 'cat'}});

const ME = 'user0grace0000000000000000';
const CAPTAIN = 'bot00captain00000000000000';
const PASSWORD = 'captain';

const channels = {};
function addChannel(id, name, display, type, memberIds) {
    channels[id] = {
        id, team_id: type === 'D' || type === 'G' ? '' : team.id, type, name, display_name: display,
        header: '', purpose: '', create_at: 0, update_at: 0, delete_at: 0, last_post_at: 0, last_root_post_at: 0,
        total_msg_count: 0, total_msg_count_root: 0, creator_id: ME, scheme_id: null, group_constrained: null,
        members: memberIds,
    };
}
addChannel('chan0launch00000000000000', 'launch-room', 'Launch room', 'O', [ME, 'user0sunny0000000000000000', 'user0lisen0000000000000000', CAPTAIN, 'bot00researcher00000000000']);
addChannel('chan0design00000000000000', 'design-review', 'Design review', 'P', [ME, 'user0sunny0000000000000000', 'bot00designer0000000000000', CAPTAIN]);
addChannel('chan0creators000000000000', 'founding-creators', 'Founding creators', 'O', [ME, 'user0lisen0000000000000000', CAPTAIN]);
addChannel('chan0dmcaptain00000000000', `${CAPTAIN}__${ME}`, '', 'D', [ME, CAPTAIN]);
addChannel('chan0dmsunny0000000000000', `${ME}__user0sunny0000000000000000`, '', 'D', [ME, 'user0sunny0000000000000000']);

const members = {}; // `${channelId}:${userId}` -> membership
for (const ch of Object.values(channels)) {
    for (const uid of ch.members) {
        members[`${ch.id}:${uid}`] = {
            channel_id: ch.id, user_id: uid, roles: 'channel_user', last_viewed_at: 0, msg_count: 0, msg_count_root: 0,
            mention_count: 0, mention_count_root: 0, urgent_mention_count: 0, notify_props: {}, last_update_at: 0,
            scheme_user: true, scheme_admin: false,
        };
    }
}

const posts = {};
const files = {};

function makePost(channelId, userId, message, extra = {}) {
    const t = extra.create_at ?? now();
    return {
        id: newId(), create_at: t, update_at: t, edit_at: 0, delete_at: 0, is_pinned: false,
        user_id: userId, channel_id: channelId, root_id: '', original_id: '', message, type: '',
        props: {}, hashtags: '', file_ids: [], pending_post_id: '', reply_count: 0, last_reply_at: 0,
        participants: null, metadata: {}, ...extra,
    };
}

function mentionedUserIds(post) {
    const ch = channels[post.channel_id];
    const ids = new Set();
    for (const m of post.message.matchAll(/@([a-z0-9._-]+)/gi)) {
        const u = Object.values(users).find((x) => x.username === m[1].toLowerCase());
        if (u && ch.members.includes(u.id)) {
            ids.add(u.id);
        }
        if (['all', 'channel', 'here'].includes(m[1].toLowerCase())) {
            ch.members.forEach((id) => ids.add(id));
        }
    }
    ids.delete(post.user_id);
    return [...ids];
}

function storePost(post, {broadcast = true} = {}) {
    const ch = channels[post.channel_id];
    posts[post.id] = post;
    if (post.root_id && posts[post.root_id]) {
        posts[post.root_id].reply_count += 1;
        posts[post.root_id].last_reply_at = post.create_at;
    }
    ch.last_post_at = post.create_at;
    ch.total_msg_count += 1;
    if (!post.root_id) {
        ch.last_root_post_at = post.create_at;
        ch.total_msg_count_root += 1;
    }
    const mentions = mentionedUserIds(post);
    for (const uid of ch.members) {
        const m = members[`${ch.id}:${uid}`];
        if (uid === post.user_id) {
            m.msg_count = ch.total_msg_count;
            m.msg_count_root = ch.total_msg_count_root;
            m.last_viewed_at = post.create_at;
        } else if (mentions.includes(uid) || (ch.type === 'D' && broadcast)) {
            m.mention_count += 1;
        }
    }
    if (broadcast) {
        const sender = users[post.user_id];
        publish({
            event: 'posted',
            data: {
                channel_display_name: ch.display_name, channel_name: ch.name, channel_type: ch.type,
                post: JSON.stringify(post), sender_name: `@${sender.username}`, team_id: ch.team_id,
                mentions: mentions.length ? JSON.stringify(mentions) : undefined, set_online: true,
            },
            broadcast: {omit_users: null, user_id: '', channel_id: ch.id, team_id: ''},
        }, ch.members);
    }
    return post;
}

function decisionPost(channelId, rootId = '') {
    return makePost(channelId, CAPTAIN, 'I need your sign-off before I send this.', {
        root_id: rootId,
        type: 'custom_captain_decision',
        props: {
            decision: {
                title: 'Send the creator invite email to 50 founding creators',
                reason: 'The draft passed review and the list is deduplicated. Sending uses 50 of this month\'s 400 email credits.',
                fields: [
                    {label: 'Recipients', value: '50 creators (Priority A list)'},
                    {label: 'Send from', value: 'grace@captainspace.ai'},
                    {label: 'Cost', value: '50 email credits'},
                ],
                status: 'pending', decided_by: '', decided_at: 0,
            },
            attachments: [{actions: [
                {id: 'approve', name: 'Approve', type: 'button', style: 'primary'},
                {id: 'reject', name: 'Reject', type: 'button', style: 'default'},
            ]}],
        },
    });
}

// Seed a little history so the app has something to show.
(function seed() {
    const t0 = now() - 1000 * 60 * 60 * 5;
    const seedPosts = [
        ['chan0launch00000000000000', 'user0sunny0000000000000000', 'Morning! Product Hunt page draft is in the drive. Can someone check the tagline?', 0],
        ['chan0launch00000000000000', ME, '@captain can you compare our tagline against the top 10 launches this month?', 4],
        ['chan0launch00000000000000', CAPTAIN, 'Done. Ours is the only one that names a concrete outcome. Two suggestions in the thread: shorten to 8 words, and lead with "one line".', 6],
        ['chan0launch00000000000000', 'bot00researcher00000000000', 'Sources: I checked 10 launches from this month and 3 from last month with similar positioning.', 7],
        ['chan0launch00000000000000', 'user0lisen0000000000000000', 'Staging is green. I will cut the release branch after lunch.', 90],
        ['chan0design00000000000000', 'user0sunny0000000000000000', 'New onboarding screens are up. Thoughts on the navy rail width?', 30],
        ['chan0design00000000000000', 'bot00designer0000000000000', 'I drafted two variants: 232px and 216px. 216 keeps the chat list readable at 13px.', 33],
        ['chan0creators000000000000', 'user0lisen0000000000000000', 'Creator outreach sheet is updated with Priority A tier.', 60],
        ['chan0dmcaptain00000000000', CAPTAIN, 'Hi Grace. Mention me in any chat, or DM me here, and I will route the work to the best model.', 2],
        ['chan0dmsunny0000000000000', 'user0sunny0000000000000000', 'Can we do the investor deck review at 4?', 200],
    ];
    for (const [ch, uid, msg, mins] of seedPosts) {
        storePost(makePost(ch, uid, msg, {create_at: t0 + mins * 60 * 1000}), {broadcast: false});
    }
    // Grace has read everything except the latest launch-room and Sunny messages.
    for (const ch of Object.values(channels)) {
        const m = members[`${ch.id}:${ME}`];
        const read = ['chan0launch00000000000000', 'chan0dmsunny0000000000000'].includes(ch.id) ? ch.total_msg_count - 1 : ch.total_msg_count;
        m.msg_count = read;
        m.msg_count_root = read;
        m.mention_count = ch.id === 'chan0dmsunny0000000000000' ? 1 : 0;
    }
    storePost(decisionPost('chan0launch00000000000000'), {broadcast: false});
    members[`chan0launch00000000000000:${ME}`].mention_count = 1;
}());

// ---------------------------------------------------------------- websocket

const sockets = new Set(); // {ws, userId, seq, connectionId}

function publish(event, userIds) {
    for (const s of sockets) {
        if (userIds && !userIds.includes(s.userId)) {
            continue;
        }
        if (s.ws.readyState === 1) {
            s.ws.send(JSON.stringify({...event, seq: s.seq++}));
        }
    }
}

// ---------------------------------------------------------------- agents

function captainReply(post) {
    if (BRIDGE_MODE) {
        return;
    }
    const ch = channels[post.channel_id];
    if (!ch.members.includes(CAPTAIN) || post.user_id === CAPTAIN || users[post.user_id].is_bot) {
        return;
    }
    const mentioned = /@captain\b/i.test(post.message) || ch.type === 'D';
    if (!mentioned) {
        return;
    }
    const rootId = post.root_id || (ch.type === 'D' ? '' : post.id);
    setTimeout(() => publish({event: 'typing', data: {parent_id: rootId, user_id: CAPTAIN}, broadcast: {channel_id: ch.id, omit_users: null, user_id: '', team_id: ''}}, ch.members), 300);
    setTimeout(() => {
        if (/decision|approve|send/i.test(post.message)) {
            storePost(decisionPost(ch.id, rootId));
            return;
        }
        const hasImage = post.file_ids?.length > 0;
        const text = hasImage ?
            'Got the screenshot. I can see the screen you captured; I will pull out the key points and post a summary here.' :
            `On it. I will route this to the best model and reply in this thread. (Mock reply to: "${post.message.slice(0, 80)}")`;
        storePost(makePost(ch.id, CAPTAIN, text, {root_id: rootId}));
    }, 1300);
}

// ---------------------------------------------------------------- http

const sessions = new Map(); // token -> userId
if (BRIDGE_MODE) {
    for (const u of Object.values(users).filter((x) => x.is_bot)) {
        sessions.set(`bot-${u.username}`, u.id);
    }
}

function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {'Content-Type': 'application/json', ...headers});
    res.end(data);
}
function apiError(res, status, message, id = 'api.mock.error') {
    send(res, status, {id, message, detailed_error: '', request_id: newId(), status_code: status});
}
function readJson(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => {
            raw += c;
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                resolve({});
            }
        });
    });
}
function authUser(req) {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '') || new URL(req.url, 'http://x').searchParams.get('access_token');
    return sessions.get(token);
}
function myChannels() {
    return Object.values(channels).filter((c) => c.members.includes(ME)).map(({members: _m, ...c}) => c);
}
function postList(list) {
    const sorted = list.sort((a, b) => b.create_at - a.create_at);
    return {order: sorted.map((p) => p.id), posts: Object.fromEntries(sorted.map((p) => [p.id, p])), next_post_id: '', prev_post_id: '', has_next: false};
}
function initials(u) {
    return ((u.first_name || u.username)[0] + (u.last_name?.[0] || '')).toUpperCase();
}

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-CSRF-Token, Accept-Language');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Token, X-Version-Id');
    res.setHeader('X-Version-Id', '11.9.0.mock');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname.replace(/^\/api\/v4/, '');
    const m = (re) => p.match(re);
    let match;

    // Public routes
    if (p === '/system/ping') {
        return send(res, 200, {status: 'OK'});
    }
    if (p === '/users/login' && req.method === 'POST') {
        const body = await readJson(req);
        const user = Object.values(users).find((u) => !u.is_bot && (u.username === body.login_id || u.email === body.login_id));
        if (!user || body.password !== PASSWORD) {
            return apiError(res, 401, 'Enter a valid email or username and/or password.', 'api.user.login.invalid_credentials_email_username');
        }
        const token = newId();
        sessions.set(token, user.id);
        return send(res, 200, user, {Token: token});
    }
    if ((match = m(/^\/users\/([a-z0-9]+)\/image$/))) {
        const u = users[match[1]];
        if (u?.props?.portrait) {
            const file = path.join(PUBLIC_DIR, 'agents', `${u.props.portrait}.png`);
            res.writeHead(200, {'Content-Type': 'image/png'});
            return fs.createReadStream(file).pipe(res);
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#315D9B"/><text x="48" y="58" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${u ? initials(u) : '?'}</text></svg>`;
        return send(res, 200, svg, {'Content-Type': 'image/svg+xml'});
    }
    if ((match = m(/^\/files\/([a-z0-9]+)(\/thumbnail|\/preview)?$/)) && req.method === 'GET') {
        const f = files[match[1]];
        if (!f) {
            return apiError(res, 404, 'File not found');
        }
        return send(res, 200, f.data, {'Content-Type': f.info.mime_type});
    }
    if (p === '/dev/simulate' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.kind === 'decision') {
            storePost(decisionPost(body.channel_id || 'chan0launch00000000000000'));
        } else if (body.kind === 'dm') {
            storePost(makePost('chan0dmsunny0000000000000', 'user0sunny0000000000000000', body.message || 'Quick one: can you look at the pricing slide before 5?'));
        } else {
            storePost(makePost('chan0launch00000000000000', 'user0lisen0000000000000000', body.message || '@grace the release notes need your call on the headline. Option A or B?'));
        }
        return send(res, 200, {status: 'OK'});
    }

    const userId = authUser(req);
    if (!userId) {
        return apiError(res, 401, 'Invalid or expired session, please login again.', 'api.context.session_expired.app_error');
    }

    if (p === '/users/logout' && req.method === 'POST') {
        sessions.delete((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        return send(res, 200, {status: 'OK'});
    }
    if (p === '/users/me') {
        return send(res, 200, users[userId]);
    }
    if (p === '/users/ids' && req.method === 'POST') {
        const ids = await readJson(req);
        return send(res, 200, (Array.isArray(ids) ? ids : []).map((id) => users[id]).filter(Boolean));
    }
    if ((match = m(/^\/users\/([a-z0-9]{26})$/)) && req.method === 'GET') {
        return users[match[1]] ? send(res, 200, users[match[1]]) : apiError(res, 404, 'User not found');
    }
    if ((match = m(/^\/channels\/([a-z0-9]{26})$/)) && req.method === 'GET') {
        const {members: _m, ...c} = channels[match[1]] || {};
        return c.id ? send(res, 200, c) : apiError(res, 404, 'Channel not found');
    }
    if ((match = m(/^\/posts\/([a-z0-9]+)$/)) && req.method === 'GET') {
        return posts[match[1]] ? send(res, 200, posts[match[1]]) : apiError(res, 404, 'Post not found');
    }
    if ((match = m(/^\/users\/me\/channels\/([a-z0-9]{26})\/member$/))) {
        return send(res, 200, members[`${match[1]}:${userId}`]);
    }
    if (p === '/users' && req.method === 'GET') {
        return send(res, 200, Object.values(users));
    }
    if (p === '/users/me/teams') {
        return send(res, 200, [team]);
    }
    if ((match = m(/^\/users\/me\/teams\/[a-z0-9]+\/channels$/))) {
        return send(res, 200, myChannels());
    }
    if ((match = m(/^\/users\/me\/teams\/[a-z0-9]+\/channels\/members$/))) {
        return send(res, 200, myChannels().map((c) => members[`${c.id}:${userId}`]));
    }
    if ((match = m(/^\/channels\/([a-z0-9]+)\/posts$/))) {
        const ch = channels[match[1]];
        if (!ch || !ch.members.includes(userId)) {
            return apiError(res, 403, 'You do not have the appropriate permissions.');
        }
        const perPage = Number(url.searchParams.get('per_page') || 60);
        const list = Object.values(posts).filter((x) => x.channel_id === ch.id && !x.delete_at).sort((a, b) => b.create_at - a.create_at).slice(0, perPage);
        return send(res, 200, postList(list));
    }
    if ((match = m(/^\/posts\/([a-z0-9]+)\/thread$/))) {
        const root = posts[match[1]];
        if (!root) {
            return apiError(res, 404, 'Post not found');
        }
        const rootId = root.root_id || root.id;
        return send(res, 200, postList(Object.values(posts).filter((x) => x.id === rootId || x.root_id === rootId)));
    }
    if (p === '/posts' && req.method === 'POST') {
        const body = await readJson(req);
        const ch = channels[body.channel_id];
        if (!ch || !ch.members.includes(userId)) {
            return apiError(res, 403, 'You do not have the appropriate permissions.');
        }
        if (!body.message?.trim() && !(body.file_ids?.length)) {
            return apiError(res, 400, 'Message must not be empty');
        }
        const post = storePost(makePost(ch.id, userId, body.message || '', {
            root_id: body.root_id || '', file_ids: body.file_ids || [], pending_post_id: body.pending_post_id || '',
            type: typeof body.type === 'string' && body.type.startsWith('custom_') ? body.type : '', props: body.props || {},
            metadata: body.file_ids?.length ? {files: body.file_ids.map((id) => files[id]?.info).filter(Boolean)} : {},
        }));
        captainReply(post);
        return send(res, 201, post);
    }
    if ((match = m(/^\/posts\/([a-z0-9]+)\/actions\/([a-z_-]+)$/)) && req.method === 'POST') {
        const post = posts[match[1]];
        const action = (post?.props?.attachments || []).flatMap((a) => a.actions || []).find((a) => a.id === match[2]);
        if (action?.integration?.url) {
            const ch = channels[post.channel_id];
            const upstream = await fetch(action.integration.url, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({user_id: userId, user_name: users[userId].username, channel_id: post.channel_id, channel_name: ch.name, team_id: ch.team_id, post_id: post.id, type: 'button', context: action.integration.context || {}}),
            }).catch((e) => ({ok: false, status: 502, json: async () => ({ephemeral_text: e.message})}));
            const reply = await upstream.json().catch(() => ({}));
            if (reply.update) {
                if (reply.update.message) {
                    post.message = reply.update.message;
                }
                if (reply.update.props) {
                    post.props = reply.update.props;
                }
                post.update_at = now();
                publish({event: 'post_edited', data: {post: JSON.stringify(post)}, broadcast: {channel_id: post.channel_id, omit_users: null, user_id: '', team_id: ''}}, channels[post.channel_id].members);
            }
            return send(res, upstream.ok ? 200 : 400, {status: upstream.ok ? 'OK' : 'FAIL'});
        }
        const decision = post?.props?.decision;
        if (!decision) {
            return apiError(res, 404, 'Action not found');
        }
        if (decision.status === 'pending') {
            decision.status = match[2] === 'approve' ? 'approved' : 'rejected';
            decision.decided_by = userId;
            decision.decided_at = now();
            post.update_at = now();
            publish({event: 'post_edited', data: {post: JSON.stringify(post)}, broadcast: {channel_id: post.channel_id, omit_users: null, user_id: '', team_id: ''}}, channels[post.channel_id].members);
            setTimeout(() => storePost(makePost(post.channel_id, CAPTAIN,
                decision.status === 'approved' ? 'Approved. Sending now; I will post the delivery report here.' : 'Okay, I will hold it. Tell me what to change.',
                {root_id: post.root_id || post.id})), 700);
        }
        return send(res, 200, {status: 'OK'});
    }
    if (p === '/channels/members/me/view' && req.method === 'POST') {
        const body = await readJson(req);
        const ch = channels[body.channel_id];
        const mem = ch && members[`${ch.id}:${userId}`];
        if (mem) {
            mem.msg_count = ch.total_msg_count;
            mem.msg_count_root = ch.total_msg_count_root;
            mem.mention_count = 0;
            mem.last_viewed_at = now();
            publish({event: 'channel_viewed', data: {channel_id: ch.id}, broadcast: {user_id: userId, channel_id: '', team_id: '', omit_users: null}}, [userId]);
        }
        return send(res, 200, {status: 'OK', last_viewed_at_times: {}});
    }
    if (p === '/files' && req.method === 'POST') {
        const infos = [];
        const clientIds = [];
        let channelId = '';
        const bb = busboy({headers: req.headers});
        bb.on('field', (name, val) => {
            if (name === 'channel_id') {
                channelId = val;
            } else if (name === 'client_ids') {
                clientIds.push(val);
            }
        });
        bb.on('file', (_name, stream, info) => {
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => {
                const data = Buffer.concat(chunks);
                const id = newId();
                const ext = path.extname(info.filename).slice(1).toLowerCase();
                files[id] = {data, info: {
                    id, user_id: userId, channel_id: channelId, name: info.filename, extension: ext, size: data.length,
                    mime_type: info.mimeType, width: 0, height: 0, has_preview_image: info.mimeType.startsWith('image/'),
                    create_at: now(), update_at: now(), delete_at: 0,
                }};
                infos.push(files[id].info);
            });
        });
        bb.on('close', () => send(res, 201, {file_infos: infos, client_ids: clientIds}));
        req.pipe(bb);
        return undefined;
    }
    return apiError(res, 404, `Mock server has no route for ${req.method} ${p}`);
});

const wss = new WebSocketServer({noServer: true});
server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/v4/websocket')) {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = {ws, userId: null, seq: 0, connectionId: newId()};
        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (msg.action === 'authentication_challenge') {
                const uid = sessions.get(msg.data?.token);
                ws.send(JSON.stringify(uid ? {status: 'OK', seq_reply: msg.seq} : {status: 'FAIL', seq_reply: msg.seq, error: {id: 'api.web_socket_router.not_authenticated.app_error'}}));
                if (uid) {
                    conn.userId = uid;
                    sockets.add(conn);
                    ws.send(JSON.stringify({event: 'hello', data: {connection_id: conn.connectionId, server_version: '11.9.0.mock', server_hostname: 'mock'}, broadcast: {user_id: uid}, seq: conn.seq++}));
                }
                return;
            }
            if (msg.action === 'user_typing' && conn.userId) {
                const ch = channels[msg.data?.channel_id];
                if (ch) {
                    publish({event: 'typing', data: {parent_id: msg.data.parent_id || '', user_id: conn.userId}, broadcast: {channel_id: ch.id, omit_users: {[conn.userId]: true}, user_id: '', team_id: ''}}, ch.members.filter((id) => id !== conn.userId));
                }
            }
            ws.send(JSON.stringify({status: 'OK', seq_reply: msg.seq, data: msg.action === 'ping' ? {text: 'pong', version: '11.9.0.mock', server_time: now()} : {}}));
        });
        ws.on('close', () => sockets.delete(conn));
    });
});

server.listen(PORT, () => {
    console.log(`Mock Mattermost on http://localhost:${PORT}  (sign in: grace / ${PASSWORD})${BRIDGE_MODE ? '  [bridge mode: agents come from ../bridge, bot tokens bot-<username>]' : ''}`);
});
