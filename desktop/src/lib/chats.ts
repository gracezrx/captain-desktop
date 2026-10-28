import {channelTitle, isAgentChannel, unreadCount, useStore} from './store';
import type {Channel} from './types';

export type ChatKind = 'agent' | 'channel' | 'dm';
export type ChatEntry = {channel: Channel; title: string; kind: ChatKind; unread: number; mentions: number};

// Every chat you're in, most recently active first.
export function useChats(): ChatEntry[] {
    const channels = useStore((s) => s.channels);
    const members = useStore((s) => s.members);
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me);
    if (!me) {
        return [];
    }
    return Object.values(channels).
        map((channel) => ({
            channel,
            title: channelTitle(channel, me.id, users),
            kind: (isAgentChannel(channel, me.id, users) ? 'agent' : channel.type === 'D' || channel.type === 'G' ? 'dm' : 'channel') as ChatKind,
            unread: unreadCount(channel, members[channel.id]),
            mentions: members[channel.id]?.mentionCount ?? 0,
        })).
        sort((a, b) => (b.channel.lastPostAt || b.channel.createdAt) - (a.channel.lastPostAt || a.channel.createdAt));
}
