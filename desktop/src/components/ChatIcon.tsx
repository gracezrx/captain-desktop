import {Lock, Users} from 'lucide-react';

import {otherUserId, useStore} from '../lib/store';
import type {Channel} from '../lib/types';

import {Avatar} from './Avatar';

// DMs show the other person's (or agent's) avatar; group chats a soft tile
// (a lock for private ones).
export function ChatIcon({channel, size = 28}: {channel: Channel | undefined; size?: number}) {
    const me = useStore((s) => s.me);
    const other = useStore((s) => (channel?.type === 'D' && me ? s.users[otherUserId(channel, me.id)] : undefined));
    if (!channel) {
        return <span className='inline-block shrink-0 rounded-lg bg-tint' style={{width: size, height: size}}/>;
    }
    if (channel.type === 'D') {
        return <Avatar user={other} size={size}/>;
    }
    const Icon = channel.type === 'P' ? Lock : Users;
    return (
        <span className='grid shrink-0 place-items-center bg-tint text-accent-text' style={{width: size, height: size, borderRadius: Math.round(size * 0.32)}} aria-hidden>
            <Icon size={Math.round(size * 0.5)} strokeWidth={2.25}/>
        </span>
    );
}
