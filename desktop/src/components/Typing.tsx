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
                    <span className='flex gap-0.5'>
                        <span className='size-1 rounded-full bg-muted'/>
                        <span className='size-1 rounded-full bg-muted opacity-70'/>
                        <span className='size-1 rounded-full bg-muted opacity-40'/>
                    </span>
                    {displayName(user)} is {user?.is_bot ? 'working' : 'typing'}…
                </span>
            )}
        </div>
    );
}
