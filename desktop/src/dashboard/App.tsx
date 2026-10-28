import {useEffect, useState} from 'react';

import {SignIn} from '../components/SignIn';
import {resume, startSession, stopSession} from '../lib/boot';
import {signOut} from '../lib/mm';
import {onOpenChannel} from '../lib/native';
import {useStore} from '../lib/store';

import {ChatView} from './ChatView';
import {Sidebar} from './Sidebar';

export function App() {
    const [phase, setPhase] = useState<'loading' | 'signed-out' | 'ready'>('loading');
    const ready = useStore((s) => s.ready);
    const activeChannelId = useStore((s) => s.activeChannelId);
    const setActive = useStore((s) => s.setActiveChannel);

    useEffect(() => {
        resume().then((ok) => setPhase(ok ? 'ready' : 'signed-out'));
    }, []);

    useEffect(() => onOpenChannel((id) => setActive(id)), [setActive]);

    if (phase === 'loading' || (phase === 'ready' && !ready)) {
        return (
            <div className='wash grid h-full place-items-center'>
                <img src='/captain-mark.png' alt='Captain' className='size-10 animate-pulse opacity-70'/>
            </div>
        );
    }
    if (phase === 'signed-out') {
        return (
            <SignIn
                onSignedIn={async (session) => {
                    await startSession(session);
                    setPhase('ready');
                }}
            />
        );
    }
    return (
        <div className='flex h-full'>
            <Sidebar
                onSignOut={async () => {
                    stopSession();
                    await signOut();
                    setPhase('signed-out');
                }}
            />
            <main className='wash flex min-w-0 flex-1 flex-col'>
                <ChatView channelId={activeChannelId}/>
            </main>
        </div>
    );
}
