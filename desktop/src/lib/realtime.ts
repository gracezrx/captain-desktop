// Real-time events. The dashboard window owns the one WebSocket to
// Mattermost, applies each event to its store, sends notifications, sets the
// menu bar badge, and relays the event to the panel window. In a plain
// browser each page opens its own socket.

import {WebSocketClient} from '@mattermost/client';
import type {Post} from '@mattermost/types/posts';

import {type Session, websocketUrl} from './mm';
import {isTauri, notify, onRelayedEvent, relayToPanel, setBadge, windowLabel} from './native';
import {channelTitle, decisionOf, displayName, needsYou, useStore} from './store';

type MmEvent = {
    event: string;
    data: Record<string, unknown>;
    broadcast: {channel_id?: string; user_id?: string};
};

let socket: WebSocketClient | null = null;
let stopRelay: (() => void) | null = null;

export function startRealtime(session: Session): () => void {
    const owner = !isTauri || windowLabel() === 'main';
    const sendsNotifications = windowLabel() === 'main';

    if (!owner) {
        useStore.getState().setConnection('online');
        stopRelay = onRelayedEvent((e) => handleEvent(e as MmEvent, false));
        return () => stopRelay?.();
    }

    socket = new WebSocketClient();
    socket.addMessageListener((msg) => {
        handleEvent(msg as unknown as MmEvent, sendsNotifications);
        void relayToPanel(msg);
    });
    socket.addFirstConnectListener(() => useStore.getState().setConnection('online'));
    socket.addReconnectListener(() => {
        useStore.getState().setConnection('online');
        // Catch up on anything missed while disconnected.
        const s = useStore.getState();
        if (s.session) {
            void s.bootstrap(s.session).then(() => {
                if (s.activeChannelId) {
                    void useStore.getState().loadPosts(s.activeChannelId);
                }
            });
        }
    });
    socket.addCloseListener(() => useStore.getState().setConnection('offline'));
    socket.initialize(websocketUrl(session.serverUrl), session.token);

    let lastBadge = -1;
    const unsubscribe = useStore.subscribe((s) => {
        const count = needsYou(s).length;
        if (count !== lastBadge) {
            lastBadge = count;
            void setBadge(count);
        }
    });

    return () => {
        unsubscribe();
        socket?.close();
        socket = null;
    };
}

export function sendTyping(channelId: string, rootId = ''): void {
    socket?.userTyping(channelId, rootId);
}

function handleEvent(msg: MmEvent, sendsNotifications: boolean): void {
    const store = useStore.getState();
    const me = store.me;
    switch (msg.event) {
    case 'posted': {
        const post = JSON.parse(msg.data.post as string) as Post;
        const mentions = msg.data.mentions ? (JSON.parse(msg.data.mentions as string) as string[]) : [];
        const channelType = msg.data.channel_type as string;
        const fromOthers = post.user_id !== me?.id;
        const mentionsMe = fromOthers && (mentions.includes(me?.id ?? '') || channelType === 'D' || channelType === 'G' || Boolean(decisionOf(post)));
        const wasKnown = Boolean(store.posts[post.id]);
        store.receivePost(post, {fromOthers, mentionsMe});
        // A message from someone ends their "is typing".
        if (store.typing[post.channel_id]?.userId === post.user_id) {
            useStore.setState((s) => {
                const typing = {...s.typing};
                delete typing[post.channel_id];
                return {typing};
            });
        }
        if (sendsNotifications && mentionsMe && !wasKnown) {
            void notifyAbout(post);
        }
        break;
    }
    case 'post_edited': {
        store.updatePost(JSON.parse(msg.data.post as string) as Post);
        break;
    }
    case 'typing': {
        const channelId = msg.broadcast.channel_id;
        if (channelId && msg.data.user_id !== me?.id) {
            store.setTyping(channelId, msg.data.user_id as string);
        }
        break;
    }
    case 'channel_viewed': {
        const channelId = msg.data.channel_id as string;
        const c = store.channels[channelId];
        const m = store.members[channelId];
        if (c && m) {
            useStore.setState((s) => ({members: {...s.members, [channelId]: {...m, msg_count: c.total_msg_count, mention_count: 0}}}));
        }
        break;
    }
    default:
        break;
    }
}

async function notifyAbout(post: Post): Promise<void> {
    const s = useStore.getState();
    // Don't interrupt when the dashboard is in front showing that chat.
    if (document.hasFocus() && s.activeChannelId === post.channel_id) {
        return;
    }
    await s.ensureUsers([post.user_id]);
    const st = useStore.getState();
    const sender = displayName(st.users[post.user_id]);
    const channel = st.channels[post.channel_id];
    const where = channel && channel.type !== 'D' ? ` in ${channelTitle(channel, st.me?.id, st.users)}` : '';
    const decision = decisionOf(post);
    const title = decision ? `${sender} needs a decision${where}` : `${sender}${where}`;
    const body = decision ? decision.title : post.message.slice(0, 180) || 'Sent an attachment';
    await notify(title, body, {mode: 'thread', channelId: post.channel_id, postId: post.id});
}
