import {useEffect, useState} from 'react';

import {AuthScreen, field, inviteFromUrl} from '../components/AuthScreen';
import {api, errorMessage} from '../lib/api';
import {endSession, resume, startSession, whenSignedOut} from '../lib/boot';
import {onOpenChannel} from '../lib/native';
import {onOpenSetup, setupSeen} from '../lib/setup';
import {useStore} from '../lib/store';
import {startTalkBridge} from '../lib/talk';

import {ChatView} from './ChatView';
import {BrowseChannels, NewChannel, NewMessage, SearchMessages} from './Dialogs';
import {Settings} from './Settings';
import {SetupGuide} from './SetupGuide';
import {Sidebar, type SidebarAction} from './Sidebar';

function clearInviteParam() {
    try {
        const url = new URL(location.href);
        url.searchParams.delete('invite');
        history.replaceState(null, '', url.toString());
    } catch {
        // nothing to clear
    }
}

// Signed in with an invite link in the address: join that workspace.
async function acceptPendingInvite(): Promise<void> {
    const token = inviteFromUrl();
    if (!token) {
        return;
    }
    clearInviteParam();
    try {
        const ws = await api.acceptInvite(token);
        const workspaces = await api.workspaces();
        useStore.setState({workspaces});
        await useStore.getState().switchWorkspace(ws.id);
    } catch {
        // already a member, or the link expired: carry on
    }
}

export function App() {
    const [phase, setPhase] = useState<'loading' | 'signed-out' | 'ready'>('loading');
    const ready = useStore((s) => s.ready);
    const workspace = useStore((s) => s.workspace);
    const activeChannelId = useStore((s) => s.activeChannelId);
    const setActive = useStore((s) => s.setActiveChannel);
    const [dialog, setDialog] = useState<SidebarAction | 'setup' | null>(null);

    // Questions asked out loud through the floating talk button.
    useEffect(() => startTalkBridge(), []);

    useEffect(() => {
        whenSignedOut(() => setPhase('signed-out'));
        resume().then(async (ok) => {
            if (ok) {
                await acceptPendingInvite();
            }
            setPhase(ok ? 'ready' : 'signed-out');
        });
    }, []);

    useEffect(() => onOpenChannel((id) => setActive(id)), [setActive]);

    // The setup guide: from the menu bar icon, Home or Settings, and once on
    // its own the first time you're in.
    useEffect(() => onOpenSetup(() => setDialog('setup')), []);
    const inWorkspace = phase === 'ready' && ready && Boolean(workspace);
    useEffect(() => {
        if (inWorkspace && !setupSeen()) {
            setDialog((d) => d ?? 'setup');
        }
    }, [inWorkspace]);

    if (phase === 'loading' || (phase === 'ready' && !ready)) {
        return (
            <div className='wash grid h-full place-items-center'>
                <img src='/captain-mark.png' alt='Captain' className='size-10 animate-pulse opacity-70'/>
            </div>
        );
    }
    if (phase === 'signed-out') {
        return (
            <AuthScreen
                onSignedIn={async (session) => {
                    setPhase('loading');
                    await startSession(session);
                    await acceptPendingInvite();
                    clearInviteParam();
                    setPhase('ready');
                }}
            />
        );
    }
    if (!workspace) {
        return <NoWorkspace onSignOut={() => void endSession()}/>;
    }
    return (
        <div className='flex h-full'>
            <Sidebar onSignOut={() => void endSession()} onAction={setDialog}/>
            <main className='wash flex min-w-0 flex-1 flex-col'>
                <ChatView channelId={activeChannelId} onInvite={() => setDialog('invite')} onModels={() => setDialog('models')}/>
            </main>
            {dialog === 'new-channel' && <NewChannel onClose={() => setDialog(null)}/>}
            {dialog === 'browse' && <BrowseChannels onClose={() => setDialog(null)}/>}
            {dialog === 'new-dm' && <NewMessage onClose={() => setDialog(null)}/>}
            {(dialog === 'settings' || dialog === 'invite') && <Settings initial='people' onClose={() => setDialog(null)}/>}
            {dialog === 'models' && <Settings initial='models' onClose={() => setDialog(null)}/>}
            {dialog === 'new-workspace' && <CreateWorkspace onClose={() => setDialog(null)}/>}
            {dialog === 'setup' && <SetupGuide onClose={() => setDialog(null)} onModels={() => setDialog('models')} onInvite={() => setDialog('invite')}/>}
            {dialog === 'search' && (
                <SearchMessages
                    onClose={() => setDialog(null)}
                    onOpen={(p) => {
                        setDialog(null);
                        setActive(p.channelId);
                        useStore.getState().mergePosts([p]);
                        if (p.rootId) {
                            useStore.getState().openThread(p.rootId);
                        }
                    }}
                />
            )}
        </div>
    );
}

function CreateWorkspace({onClose}: {onClose?: () => void}) {
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const ws = await api.createWorkspace(name);
            useStore.setState({workspaces: await api.workspaces()});
            await useStore.getState().switchWorkspace(ws.id);
            onClose?.();
        } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    };
    const form = (
        <form onSubmit={submit} className='w-full max-w-[380px] rounded-3xl bg-surface p-6 ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)'}}>
            <h2 className='text-[20px] font-extrabold tracking-tight text-ink'>New workspace</h2>
            <p className='mt-1 text-[13px] text-muted'>It comes with #general and five agents: Captain, Researcher, Writer, Analyst and Designer.</p>
            <input className={`${field} mt-4`} value={name} onChange={(e) => setName(e.target.value)} placeholder='Team name' autoFocus/>
            {error && <p className='mt-2 text-[12.5px] text-alert'>{error}</p>}
            <div className='mt-4 flex justify-end gap-2'>
                {onClose && <button type='button' onClick={onClose} className='h-10 rounded-full px-4 text-[13px] font-semibold text-muted hover:bg-tint'>Cancel</button>}
                <button type='submit' disabled={busy || !name.trim()} className='h-10 rounded-full bg-accent px-5 text-[13px] font-bold text-on-accent disabled:opacity-50'>{busy ? 'Creating…' : 'Create'}</button>
            </div>
        </form>
    );
    if (!onClose) {
        return form;
    }
    return <div className='fixed inset-0 z-40 grid place-items-center bg-[rgba(20,39,105,0.18)] p-6' onMouseDown={(e) => e.target === e.currentTarget && onClose()}>{form}</div>;
}

function NoWorkspace({onSignOut}: {onSignOut: () => void}) {
    return (
        <div data-tauri-drag-region className='wash grid h-full place-items-center px-6'>
            <div className='flex w-full max-w-[380px] flex-col items-center gap-4'>
                <img src='/captain-mark.png' alt='' className='size-12'/>
                <CreateWorkspace/>
                <p className='text-center text-[12.5px] text-muted'>Joining a team? Open the invite link they sent you.</p>
                <button type='button' onClick={onSignOut} className='text-[12.5px] font-semibold text-muted hover:text-ink'>Sign out</button>
            </div>
        </div>
    );
}
