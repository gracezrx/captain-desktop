// App state: one Zustand store per window, filled from Mattermost's REST API
// and kept current by WebSocket events (see realtime.ts).

import type {ChannelMembership, ServerChannel} from '@mattermost/types/channels';
import type {FileInfo} from '@mattermost/types/files';
import type {Post} from '@mattermost/types/posts';
import type {Team} from '@mattermost/types/teams';
import type {UserProfile} from '@mattermost/types/users';
import {create} from 'zustand';

import {client, type Session} from './mm';

export const DECISION_POST_TYPE = 'custom_captain_decision';

export type Decision = {
    title: string;
    reason: string;
    fields: {label: string; value: string}[];
    status: 'pending' | 'approved' | 'rejected';
    decided_by: string;
    decided_at: number;
};

export function decisionOf(post: Post | undefined): Decision | null {
    if (!post || (post.type as string) !== DECISION_POST_TYPE) {
        return null;
    }
    return (post.props?.decision as Decision) ?? null;
}

export type NeedsYouItem = {
    channelId: string;
    postId?: string;
    kind: 'decision' | 'mention' | 'dm';
    at: number;
};

type State = {
    session: Session | null;
    me: UserProfile | null;
    team: Team | null;
    channels: Record<string, ServerChannel>;
    members: Record<string, ChannelMembership>;
    users: Record<string, UserProfile>;
    posts: Record<string, Post>;
    postsByChannel: Record<string, string[]>; // oldest first, root posts and replies
    loadedChannels: Record<string, boolean>;
    typing: Record<string, {userId: string; until: number}>;
    activeChannelId: string | null;
    lastUsedChannelId: string | null;
    connection: 'connecting' | 'online' | 'offline';
    ready: boolean;
};

type Actions = {
    bootstrap: (session: Session) => Promise<void>;
    reset: () => void;
    loadPosts: (channelId: string) => Promise<void>;
    ensureUsers: (ids: string[]) => Promise<void>;
    receivePost: (post: Post, opts?: {fromOthers?: boolean; mentionsMe?: boolean}) => void;
    updatePost: (post: Post) => void;
    mergePosts: (posts: Post[]) => void;
    setActiveChannel: (channelId: string | null) => void;
    markViewed: (channelId: string) => Promise<void>;
    setTyping: (channelId: string, userId: string) => void;
    setConnection: (c: State['connection']) => void;
    rememberChannel: (channelId: string) => void;
};

const initial: State = {
    session: null,
    me: null,
    team: null,
    channels: {},
    members: {},
    users: {},
    posts: {},
    postsByChannel: {},
    loadedChannels: {},
    typing: {},
    activeChannelId: null,
    lastUsedChannelId: localStorage.getItem('captain.lastChannel'),
    connection: 'connecting',
    ready: false,
};

export const useStore = create<State & Actions>((set, get) => ({
    ...initial,

    async bootstrap(session) {
        set({session});
        const me = await client.getMe();
        const teams = await client.getMyTeams();
        const team = teams[0] ?? null;
        let channels: ServerChannel[] = [];
        let members: ChannelMembership[] = [];
        if (team) {
            [channels, members] = await Promise.all([client.getMyChannels(team.id), client.getMyChannelMembers(team.id)]);
        }
        const dmUserIds = channels.filter((c) => c.type === 'D').map((c) => otherUserId(c, me.id)).filter(Boolean);
        set({
            me,
            team,
            channels: Object.fromEntries(channels.filter((c) => !c.delete_at).map((c) => [c.id, c])),
            members: Object.fromEntries(members.map((m) => [m.channel_id, m])),
            users: {[me.id]: me},
            ready: true,
        });
        await get().ensureUsers(dmUserIds);
    },

    reset() {
        set({...initial, lastUsedChannelId: get().lastUsedChannelId});
    },

    async loadPosts(channelId) {
        const list = await client.getPosts(channelId, 0, 60);
        const posts = list.order.map((id) => list.posts[id]).filter(Boolean);
        set((s) => {
            const all = {...s.posts};
            for (const p of posts) {
                all[p.id] = p;
            }
            const ids = new Set([...(s.postsByChannel[channelId] ?? []), ...posts.map((p) => p.id)]);
            return {
                posts: all,
                postsByChannel: {...s.postsByChannel, [channelId]: sortIds([...ids], all)},
                loadedChannels: {...s.loadedChannels, [channelId]: true},
            };
        });
        await get().ensureUsers(posts.map((p) => p.user_id));
    },

    async ensureUsers(ids) {
        const missing = [...new Set(ids)].filter((id) => id && !get().users[id]);
        if (!missing.length) {
            return;
        }
        const profiles = await client.getProfilesByIds(missing).catch(() => []);
        set((s) => ({users: {...s.users, ...Object.fromEntries(profiles.map((u) => [u.id, u]))}}));
    },

    receivePost(post, opts = {}) {
        const s = get();
        // A post we already have, or the server's copy of one we sent optimistically.
        const known = Boolean(s.posts[post.id]) || Boolean(post.pending_post_id && post.pending_post_id !== post.id && s.posts[post.pending_post_id]);
        set((st) => {
            const all = {...st.posts, [post.id]: post};
            // Replace an optimistic copy sent from this window.
            let ids = (st.postsByChannel[post.channel_id] ?? []).filter((id) => {
                const p = st.posts[id];
                return !(p && post.pending_post_id && p.id === post.pending_post_id);
            });
            if (post.pending_post_id) {
                delete all[post.pending_post_id];
            }
            if (!ids.includes(post.id)) {
                ids = sortIds([...ids, post.id], all);
            }
            const channel = st.channels[post.channel_id];
            const channels = channel ? {...st.channels, [channel.id]: {...channel, last_post_at: Math.max(channel.last_post_at, post.create_at), total_msg_count: channel.total_msg_count + (known ? 0 : 1)}} : st.channels;
            let members = st.members;
            const m = st.members[post.channel_id];
            if (m && !known) {
                const viewing = st.activeChannelId === post.channel_id && document.hasFocus();
                const mine = post.user_id === st.me?.id;
                members = {...st.members, [m.channel_id]: {
                    ...m,
                    msg_count: mine || viewing ? m.msg_count + 1 : m.msg_count,
                    mention_count: !mine && !viewing && opts.mentionsMe ? m.mention_count + 1 : m.mention_count,
                }};
            }
            return {posts: all, postsByChannel: {...st.postsByChannel, [post.channel_id]: ids}, channels, members};
        });
        if (post.root_id && s.posts[post.root_id] && !known) {
            const root = s.posts[post.root_id];
            get().updatePost({...root, reply_count: (root.reply_count ?? 0) + 1, last_reply_at: post.create_at});
        }
        if (!s.users[post.user_id]) {
            void get().ensureUsers([post.user_id]);
        }
        if (!s.channels[post.channel_id]) {
            // A new DM or a channel we were just added to.
            void client.getChannel(post.channel_id).then((c) => set((st) => ({channels: {...st.channels, [c.id]: c}}))).catch(() => undefined);
            void client.getMyChannelMember(post.channel_id).then((m) => set((st) => ({members: {...st.members, [m.channel_id]: m}}))).catch(() => undefined);
        }
    },

    updatePost(post) {
        set((s) => ({posts: {...s.posts, [post.id]: {...s.posts[post.id], ...post}}}));
    },

    // Add fetched history (e.g. a thread) without touching unread counts.
    mergePosts(list) {
        if (!list.length) {
            return;
        }
        set((s) => {
            const all = {...s.posts};
            const byChannel = {...s.postsByChannel};
            for (const p of list) {
                all[p.id] = p;
                const ids = byChannel[p.channel_id] ?? [];
                if (!ids.includes(p.id)) {
                    byChannel[p.channel_id] = [...ids, p.id];
                }
            }
            for (const id of new Set(list.map((p) => p.channel_id))) {
                byChannel[id] = sortIds(byChannel[id], all);
            }
            return {posts: all, postsByChannel: byChannel};
        });
        void get().ensureUsers(list.map((p) => p.user_id));
    },

    setActiveChannel(channelId) {
        set({activeChannelId: channelId});
        if (channelId) {
            get().rememberChannel(channelId);
        }
    },

    async markViewed(channelId) {
        set((s) => {
            const m = s.members[channelId];
            const c = s.channels[channelId];
            if (!m || !c) {
                return {};
            }
            return {members: {...s.members, [channelId]: {...m, msg_count: c.total_msg_count, mention_count: 0, last_viewed_at: Date.now()}}};
        });
        await client.viewMyChannel(channelId).catch(() => undefined);
    },

    setTyping(channelId, userId) {
        set((s) => ({typing: {...s.typing, [channelId]: {userId, until: Date.now() + 5000}}}));
    },

    setConnection(connection) {
        set({connection});
    },

    rememberChannel(channelId) {
        localStorage.setItem('captain.lastChannel', channelId);
        set({lastUsedChannelId: channelId});
    },
}));

function sortIds(ids: string[], posts: Record<string, Post>): string[] {
    return ids.filter((id) => posts[id]).sort((a, b) => posts[a].create_at - posts[b].create_at);
}

// ------------------------------------------------------------ derived helpers

export function otherUserId(channel: ServerChannel, meId: string): string {
    if (channel.type !== 'D') {
        return '';
    }
    const [a, b] = channel.name.split('__');
    return a === meId ? b : a;
}

export function displayName(user: UserProfile | undefined): string {
    if (!user) {
        return 'Someone';
    }
    const full = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return full || user.nickname || user.username;
}

export function channelTitle(channel: ServerChannel | undefined, meId: string | undefined, users: Record<string, UserProfile>): string {
    if (!channel) {
        return '';
    }
    if (channel.type === 'D' && meId) {
        return displayName(users[otherUserId(channel, meId)]);
    }
    return channel.display_name || channel.name;
}

export function isAgentChannel(channel: ServerChannel, meId: string, users: Record<string, UserProfile>): boolean {
    return channel.type === 'D' && Boolean(users[otherUserId(channel, meId)]?.is_bot);
}

export function unreadCount(channel: ServerChannel, member: ChannelMembership | undefined): number {
    if (!member) {
        return 0;
    }
    return Math.max(0, channel.total_msg_count - member.msg_count);
}

// What needs you: pending decision cards, mentions and unread DMs, newest first.
export function needsYou(state: Pick<State, 'channels' | 'members' | 'posts' | 'postsByChannel' | 'me' | 'users'>): NeedsYouItem[] {
    const items: NeedsYouItem[] = [];
    const seen = new Set<string>();
    for (const post of Object.values(state.posts)) {
        const d = decisionOf(post);
        if (d?.status === 'pending' && state.channels[post.channel_id]) {
            items.push({channelId: post.channel_id, postId: post.id, kind: 'decision', at: post.create_at});
            seen.add(post.channel_id);
        }
    }
    for (const channel of Object.values(state.channels)) {
        const m = state.members[channel.id];
        if (!m || seen.has(channel.id)) {
            continue;
        }
        const isDm = channel.type === 'D' || channel.type === 'G';
        if (m.mention_count > 0 || (isDm && unreadCount(channel, m) > 0)) {
            const ids = state.postsByChannel[channel.id] ?? [];
            const latest = [...ids].reverse().find((id) => state.posts[id]?.user_id !== state.me?.id);
            items.push({channelId: channel.id, postId: latest, kind: isDm ? 'dm' : 'mention', at: channel.last_post_at});
        }
    }
    return items.sort((a, b) => b.at - a.at);
}

export function fileInfosOf(post: Post): FileInfo[] {
    const fromMeta = (post.metadata as {files?: FileInfo[]} | undefined)?.files;
    if (fromMeta?.length) {
        return fromMeta;
    }
    return (post.file_ids ?? []).map((id) => ({id, name: 'image', extension: 'png', mime_type: 'image/png', has_preview_image: true} as FileInfo));
}
