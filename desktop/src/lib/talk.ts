// Talking to Captain from the floating button. The button's window is tiny
// and holds no session; the dashboard window (which keeps the session and the
// live connection, even when hidden) posts the question in your DM with
// Captain, waits for Captain's answer, and hands it back to the button.

import {emitTo, listen} from '@tauri-apps/api/event';

import {plain} from '../components/Markup';

import {api} from './api';
import {isTauri} from './native';
import {sendMessage} from './send';
import {useStore} from './store';
import type {Post} from './types';

export type TalkAsk = {id: string; text: string};
export type TalkReply = {id: string; type: 'thinking' | 'answer' | 'error'; text?: string; channelId?: string};

const ANSWER_WAIT_MS = 180_000;

// Captain's answer: its first finished message after the question (a plan's
// steps come from the other agents; the summary that ends a plan is Captain's).
function answerAfter(question: Post, captainUserId: string): Post | 'decision' | null {
    const s = useStore.getState();
    const ids = s.postsByChannel[question.channelId] ?? [];
    for (const id of ids) {
        const p = s.posts[id];
        if (!p || p.userId !== captainUserId || p.createdAt < question.createdAt) {
            continue;
        }
        if (p.type === 'decision') {
            return 'decision';
        }
        if (p.type === '' && !p.props?.streaming && p.message.trim()) {
            return p;
        }
    }
    return null;
}

function waitForAnswer(question: Post, captainUserId: string): Promise<Post | 'decision' | null> {
    return new Promise((resolve) => {
        const found = answerAfter(question, captainUserId);
        if (found) {
            resolve(found);
            return;
        }
        const timer = window.setTimeout(() => {
            unsubscribe();
            resolve(null);
        }, ANSWER_WAIT_MS);
        const unsubscribe = useStore.subscribe(() => {
            const answer = answerAfter(question, captainUserId);
            if (answer) {
                window.clearTimeout(timer);
                unsubscribe();
                resolve(answer);
            }
        });
    });
}

async function ask({id, text}: TalkAsk): Promise<TalkReply> {
    const s = useStore.getState();
    if (!s.ready || !s.workspace) {
        return {id, type: 'error', text: 'Sign in to Captain first.'};
    }
    const captain = Object.values(s.agents).find((a) => a.isCoordinator && a.enabled);
    if (!captain) {
        return {id, type: 'error', text: 'This workspace has no Captain agent.'};
    }
    const dm = await api.directMessage(s.workspace.id, captain.userId);
    useStore.getState().addChannel(dm);
    if (!useStore.getState().loadedChannels[dm.id]) {
        await useStore.getState().loadPosts(dm.id).catch(() => undefined);
    }
    const question = await sendMessage({channelId: dm.id, text, attachments: []});
    await emitTo('orb', 'talk-reply', {id, type: 'thinking', channelId: dm.id} satisfies TalkReply);
    const answer = await waitForAnswer(question, captain.userId);
    if (answer === 'decision') {
        return {id, type: 'answer', channelId: dm.id, text: 'I need your OK before I do that. It\'s waiting in your inbox.'};
    }
    if (!answer) {
        return {id, type: 'error', channelId: dm.id, text: 'Captain is taking a while. The answer will be in your chat with Captain.'};
    }
    return {id, type: 'answer', channelId: dm.id, text: plain(answer.message)};
}

// Started by the dashboard window in the Mac app.
export function startTalkBridge(): () => void {
    if (!isTauri) {
        return () => undefined;
    }
    let un: (() => void) | undefined;
    let gone = false;
    listen<TalkAsk>('talk-ask', (e) => {
        void ask(e.payload).
            catch((err) => ({id: e.payload.id, type: 'error' as const, text: (err as Error)?.message || 'Something went wrong.'})).
            then((reply) => emitTo('orb', 'talk-reply', reply));
    }).then((u) => {
        if (gone) {
            u();
        } else {
            un = u;
        }
    });
    return () => {
        gone = true;
        un?.();
    };
}
