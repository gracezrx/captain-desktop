// The floating Captain's link to your workspace. Its window is tiny and holds
// no session; the dashboard window (which keeps the session and the live
// connection, even when hidden) does the work for it:
//
// - "orb-state": what the little Captain shows at rest: how many things need
//   you, and the chats and agents it can route a spoken request to.
// - "talk-ask": a spoken request and where it goes (picked on the talk card).
//   The dashboard posts it, then reports back with "talk-reply": sent, the
//   plan's steps as they move, and the answer (or a decision waiting for you).

import {emitTo, listen} from '@tauri-apps/api/event';

import {plain} from '../components/Markup';

import {api} from './api';
import {isTauri} from './native';
import {messageFor, type OrbDirectory, type Route} from './route';
import {sendMessage} from './send';
import {channelTitle, needsYou, useStore} from './store';
import type {Post, Run} from './types';

export type TalkTarget = {channelId: string | null; agentIds: string[]; dmAgentId: string | null; reply?: {rootId: string | null}};
export type TalkAsk = {id: string; text: string; target: TalkTarget | null};
export type TalkStep = {title: string; agentId: string; status: string};
export type TalkReply =
    | {id: string; type: 'sent'; channelId: string; rootId: string | null; where: string; lead: string; team: string[]}
    | {id: string; type: 'replied'; channelId: string; rootId: string | null; where: string}
    | {id: string; type: 'progress'; steps: TalkStep[]}
    | {id: string; type: 'answer'; channelId: string; rootId: string | null; postId: string; by: string; agentId: string | null; text: string}
    | {id: string; type: 'decision'; channelId: string; rootId: string | null; postId: string; text: string}
    | {id: string; type: 'error'; channelId?: string; text: string};

export type OrbState = {signedIn: boolean; needsYou: number; directory: OrbDirectory};

export function targetFor(route: Route): TalkTarget {
    const target: TalkTarget = {channelId: route.channel?.id ?? null, agentIds: route.agents.map((a) => a.id), dmAgentId: route.channel ? null : route.dmWith?.id ?? null};
    return route.reply ? {...target, reply: route.reply} : target;
}

// "Reply by voice" on the card at the top right: the floating Captain listens
// for a reply to that thread.
export type ReplyByVoice = {channelId: string; rootId: string | null; where: string};

const ANSWER_WAIT_MS = 15 * 60_000;

function directory(): OrbDirectory {
    const s = useStore.getState();
    const channels = Object.values(s.channels).
        filter((c) => (c.type === 'O' || c.type === 'P') && s.members[c.id]).
        map((c) => ({id: c.id, name: channelTitle(c, s.me?.id, s.users)}));
    const agents = Object.values(s.agents).filter((a) => a.enabled).
        map((a) => ({id: a.id, userId: a.userId, handle: a.handle, name: a.name, portrait: a.portrait, isCoordinator: a.isCoordinator}));
    return {channels, agents};
}

function orbState(): OrbState {
    const s = useStore.getState();
    const signedIn = Boolean(s.ready && s.workspace);
    return {signedIn, needsYou: signedIn ? needsYou(s).length : 0, directory: signedIn ? directory() : {channels: [], agents: []}};
}

// Keep the little Captain up to date (a light summary, at most a few times a second).
function startOrbFeed(): () => void {
    let last = '';
    let timer: number | undefined;
    const push = (force = false) => {
        const state = orbState();
        const key = JSON.stringify(state);
        if (force || key !== last) {
            last = key;
            void emitTo('orb', 'orb-state', state).catch(() => undefined);
        }
    };
    const unsubscribe = useStore.subscribe(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => push(), 300);
    });
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen('orb-hello', () => push(true)).then((u) => {
        if (gone) {
            u();
        } else {
            unlisten = u;
        }
    });
    push(true);
    return () => {
        gone = true;
        window.clearTimeout(timer);
        unsubscribe();
        unlisten?.();
    };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

// The run a message started (it's created as the message is saved).
async function runFor(channelId: string, postId: string): Promise<Run | null> {
    for (let i = 0; i < 25; i++) {
        const run = (await api.channelRuns(channelId).catch(() => [] as Run[])).find((r) => r.triggerPostId === postId);
        if (run) {
            return run;
        }
        await sleep(i < 5 ? 300 : 800);
    }
    return null;
}

async function postById(id: string): Promise<Post | null> {
    return useStore.getState().posts[id] ?? await api.post(id).catch(() => null);
}

// Follow a run until it ends: its steps as they move, a decision it waits on
// (reported, and then followed on: the answer still comes), and the answer.
async function follow(id: string, run: Run, where: string, reply: (r: TalkReply) => Promise<void>): Promise<void> {
    const wsId = useStore.getState().workspace?.id;
    let lastSteps = '';
    const told = new Set<string>();
    let busy = false;
    let again = false;
    let done = false;
    await new Promise<void>((resolve) => {
        const finish = () => {
            done = true;
            window.clearInterval(tick);
            window.clearTimeout(limit);
            unsubscribe();
            resolve();
        };
        const check = async () => {
            if (done) {
                return;
            }
            if (busy) {
                again = true;
                return;
            }
            busy = true;
            try {
                const r = await api.run(run.id);
                const steps = r.steps.map((st) => ({title: st.title, agentId: st.agentId, status: st.status}));
                const key = JSON.stringify(steps);
                if (steps.length && key !== lastSteps) {
                    lastSteps = key;
                    await reply({id, type: 'progress', steps});
                }
                if (r.status === 'waiting_approval' && wsId) {
                    const pending = (await api.approvals(wsId).catch(() => [])).filter((a) => a.runId === r.id && a.postId && !told.has(a.id));
                    for (const a of pending) {
                        told.add(a.id);
                        const card = await postById(a.postId!);
                        await reply({id, type: 'decision', channelId: a.channelId, rootId: card?.rootId ?? null, postId: a.postId!, text: a.title});
                    }
                } else if (r.status === 'succeeded') {
                    const answer = r.resultPostId ? await postById(r.resultPostId) : null;
                    const by = answer ? Object.values(useStore.getState().agents).find((a) => a.userId === answer.userId) : undefined;
                    await reply({
                        id, type: 'answer', channelId: r.channelId, rootId: answer?.rootId ?? r.rootPostId, postId: answer?.id ?? r.triggerPostId ?? '',
                        by: by?.name ?? 'Captain', agentId: by?.id ?? null, text: answer ? plain(answer.message) : `Done. The answer is in ${where}.`,
                    });
                    finish();
                } else if (r.status === 'failed' || r.status === 'cancelled') {
                    await reply({id, type: 'error', channelId: r.channelId, text: r.status === 'cancelled' ? 'That was stopped.' : `That didn't finish${r.error ? `: ${r.error}` : '.'}`});
                    finish();
                }
            } catch {
                // the next tick tries again
            } finally {
                busy = false;
                if (again && !done) {
                    again = false;
                    void check();
                }
            }
        };
        // Run updates arrive as events; a slow tick covers anything missed.
        let lastStatus = useStore.getState().runs[run.id];
        const unsubscribe = useStore.subscribe((st) => {
            if (st.runs[run.id] !== lastStatus) {
                lastStatus = st.runs[run.id];
                void check();
            }
        });
        const tick = window.setInterval(() => void check(), 4000);
        const limit = window.setTimeout(() => {
            void reply({id, type: 'error', channelId: run.channelId, text: `Still working on it. The answer will be in ${where}.`});
            finish();
        }, ANSWER_WAIT_MS);
        void check();
    });
}

async function ask({id, text, target}: TalkAsk, reply: (r: TalkReply) => Promise<void>): Promise<void> {
    const s = useStore.getState();
    if (!s.ready || !s.workspace) {
        await reply({id, type: 'error', text: 'Sign in to Captain first.'});
        return;
    }
    // A reply to a thread, said out loud: post it as it is.
    if (target?.reply && target.channelId) {
        const channelId = target.channelId;
        const rootId = target.reply.rootId;
        if (!useStore.getState().loadedChannels[channelId]) {
            await useStore.getState().loadPosts(channelId).catch(() => undefined);
        }
        await sendMessage({channelId, rootId, text, attachments: []});
        const channel = useStore.getState().channels[channelId];
        const name = channelTitle(channel, s.me?.id, s.users);
        await reply({id, type: 'replied', channelId, rootId, where: channel?.type === 'D' ? name : `# ${name}`});
        return;
    }
    const agents = Object.values(s.agents).filter((a) => a.enabled);
    const captain = agents.find((a) => a.isCoordinator);
    const named = (target?.agentIds ?? []).map((aid) => s.agents[aid]).filter((a) => a && a.enabled && !a.isCoordinator);
    const route: Route = {
        channel: target?.channelId && s.channels[target.channelId] ? {id: target.channelId, name: channelTitle(s.channels[target.channelId], s.me?.id, s.users)} : null,
        agents: named.map((a) => ({id: a.id, userId: a.userId, handle: a.handle, name: a.name, portrait: a.portrait, isCoordinator: false})),
        dmWith: null,
    };
    let channelId: string;
    let where: string;
    let lead: string;
    if (route.channel) {
        channelId = route.channel.id;
        where = `# ${route.channel.name}`;
        lead = named.length === 1 ? named[0].name : 'Captain';
    } else {
        const withAgent = (target?.dmAgentId ? s.agents[target.dmAgentId] : null) ?? captain;
        if (!withAgent) {
            await reply({id, type: 'error', text: 'This workspace has no Captain agent.'});
            return;
        }
        route.dmWith = {id: withAgent.id, userId: withAgent.userId, handle: withAgent.handle, name: withAgent.name, portrait: withAgent.portrait, isCoordinator: withAgent.isCoordinator};
        const dm = await api.directMessage(s.workspace.id, withAgent.userId);
        useStore.getState().addChannel(dm);
        channelId = dm.id;
        where = withAgent.name;
        lead = withAgent.name;
    }
    if (!useStore.getState().loadedChannels[channelId]) {
        await useStore.getState().loadPosts(channelId).catch(() => undefined);
    }
    const message = messageFor(text, route, directory());
    const question = await sendMessage({channelId, text: message, attachments: []});
    const direct = useStore.getState().channels[channelId]?.type === 'D';
    const team = named.length > 1 || (route.channel && named.length !== 1) ? named.map((a) => a.handle) : [];
    await reply({id, type: 'sent', channelId, rootId: direct ? null : question.id, where, lead, team});

    const run = await runFor(channelId, question.id);
    if (!run) {
        await reply({id, type: 'error', channelId, text: `Sent, but no agent picked it up. It's in ${where}.`});
        return;
    }
    await follow(id, run, where, reply);
}

// Started by the dashboard window in the Mac app.
export function startTalkBridge(): () => void {
    if (!isTauri) {
        return () => undefined;
    }
    const stopFeed = startOrbFeed();
    let un: (() => void) | undefined;
    let gone = false;
    const reply = (r: TalkReply) => emitTo('orb', 'talk-reply', r);
    listen<TalkAsk>('talk-ask', (e) => {
        void ask(e.payload, reply).catch((err) => reply({id: e.payload.id, type: 'error', text: (err as Error)?.message || 'Something went wrong.'}));
    }).then((u) => {
        if (gone) {
            u();
        } else {
            un = u;
        }
    });
    return () => {
        gone = true;
        stopFeed();
        un?.();
    };
}
