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
import type {Post} from './types';

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

// What came back for a request: in its thread in a channel, or after it in a
// direct message (where a plan's steps go in the plan card's thread).
type Outcome =
    | {kind: 'answer'; post: Post}
    | {kind: 'decision'; post: Post}
    | {kind: 'steps'; steps: TalkStep[]};

function outcomes(question: Post, direct: boolean): Outcome[] {
    const s = useStore.getState();
    const root = question.rootId ?? (direct ? null : question.id);
    const ids = s.postsByChannel[question.channelId] ?? [];
    const out: Outcome[] = [];
    for (const id of ids) {
        const p = s.posts[id];
        if (!p || p.id === question.id || p.createdAt < question.createdAt) {
            continue;
        }
        const inReply = root ? p.rootId === root : !p.rootId;
        if (!inReply || !s.users[p.userId]?.isBot) {
            continue;
        }
        if (p.type === 'plan' && p.props?.plan) {
            const plan = p.props.plan as {steps: TalkStep[]};
            out.push({kind: 'steps', steps: plan.steps.map((st) => ({title: st.title, agentId: st.agentId, status: st.status}))});
        } else if (p.type === 'decision') {
            if ((p.props?.decision as {status?: string} | undefined)?.status === 'pending') {
                out.push({kind: 'decision', post: p});
            }
        } else if (p.type === '' && !p.props?.streaming && p.message.trim()) {
            out.push({kind: 'answer', post: p});
        }
    }
    return out;
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

    // Follow it until there's an answer (or a decision for you).
    await new Promise<void>((resolve) => {
        let lastSteps = '';
        let finished = false;
        const check = () => {
            if (finished) {
                return;
            }
            const found = outcomes(question, direct);
            const steps = [...found].reverse().find((o) => o.kind === 'steps');
            if (steps && steps.kind === 'steps') {
                const key = JSON.stringify(steps.steps);
                if (key !== lastSteps) {
                    lastSteps = key;
                    void reply({id, type: 'progress', steps: steps.steps});
                }
            }
            // A plan's answer is Captain's, after the plan card; otherwise the first reply.
            const planned = Boolean(steps);
            const answer = found.find((o) => o.kind === 'answer' && (!planned || o.post.userId === captain?.userId));
            const decision = found.find((o) => o.kind === 'decision');
            if (answer && answer.kind === 'answer') {
                finished = true;
                const by = Object.values(useStore.getState().agents).find((a) => a.userId === answer.post.userId);
                void reply({
                    id, type: 'answer', channelId, rootId: direct ? null : question.id, postId: answer.post.id,
                    by: by?.name ?? 'Captain', agentId: by?.id ?? null, text: plain(answer.post.message),
                });
            } else if (decision && decision.kind === 'decision') {
                finished = true;
                const card = decision.post.props?.decision as {title?: string} | undefined;
                void reply({id, type: 'decision', channelId, rootId: direct ? null : question.id, postId: decision.post.id, text: card?.title ?? 'Something needs your OK.'});
            }
            if (finished) {
                window.clearTimeout(timer);
                unsubscribe();
                resolve();
            }
        };
        const timer = window.setTimeout(() => {
            finished = true;
            unsubscribe();
            void reply({id, type: 'error', channelId, text: `Still working on it. The answer will be in ${where}.`});
            resolve();
        }, ANSWER_WAIT_MS);
        const unsubscribe = useStore.subscribe(check);
        check();
    });
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
