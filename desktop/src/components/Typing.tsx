import {useEffect, useState} from 'react';

import {displayName, useStore} from '../lib/store';

export function Typing({channelId}: {channelId: string}) {
    const typing = useStore((s) => s.typing[channelId]);
    const user = useStore((s) => (typing ? s.users[typing.userId] : undefined));
    const [, tick] = useState(0);
    useEffect(() => {
        if (!typing) {
            return undefined;
        }
        const t = window.setTimeout(() => tick((n) => n + 1), Math.max(0, typing.until - Date.now()) + 50);
        return () => clearTimeout(t);
    }, [typing]);
    const visible = typing && typing.until > Date.now();
    return (
        <div className='h-6 px-2 text-[12px] text-muted' aria-live='polite'>
            {visible && (
                <span className='inline-flex items-center gap-1.5'>
                    <Dots/>
                    {displayName(user)} is typing…
                </span>
            )}
        </div>
    );
}

export function Dots() {
    return (
        <span className='flex gap-0.5' aria-hidden>
            <span className='dot size-1 rounded-full bg-muted'/>
            <span className='dot size-1 rounded-full bg-muted' style={{animationDelay: '150ms'}}/>
            <span className='dot size-1 rounded-full bg-muted' style={{animationDelay: '300ms'}}/>
        </span>
    );
}
