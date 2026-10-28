import {useEffect, useState} from 'react';

import {DEFAULT_SERVER, errorMessage, invitePreview, normalizeServer, serverConfig, signIn, signUp, type StoredSession} from '../lib/api';
import {isTauri} from '../lib/native';
import type {InvitePreview} from '../lib/types';

export const field = 'h-11 w-full rounded-2xl bg-bg-subtle px-4 text-[14px] text-ink ring-1 ring-line outline-none transition-shadow placeholder:text-muted focus:ring-2 focus:ring-accent';

export function inviteFromUrl(): string {
    try {
        return new URLSearchParams(location.search).get('invite') ?? '';
    } catch {
        return '';
    }
}

function Label({text, children}: {text: string; children: React.ReactNode}) {
    return (
        <label className='block'>
            <span className='mb-1 block px-1 text-[12px] font-semibold text-muted'>{text}</span>
            {children}
        </label>
    );
}

// Sign in, create an account, or join a workspace from an invite link.
export function AuthScreen({onSignedIn}: {onSignedIn: (s: StoredSession) => void}) {
    const invite = inviteFromUrl();
    const [mode, setMode] = useState<'signin' | 'signup'>(invite ? 'signup' : 'signin');
    const [server, setServer] = useState(() => {
        try {
            return localStorage.getItem('captain.server') || DEFAULT_SERVER;
        } catch {
            return DEFAULT_SERVER;
        }
    });
    const [editServer, setEditServer] = useState(false);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [team, setTeam] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [openSignup, setOpenSignup] = useState(true);
    const [preview, setPreview] = useState<InvitePreview | null>(null);

    useEffect(() => {
        serverConfig(server).then((c) => setOpenSignup(c.openSignup)).catch(() => undefined);
        if (invite) {
            invitePreview(server, invite).then(setPreview).catch(() => undefined);
        }
    }, [server, invite]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            try {
                localStorage.setItem('captain.server', normalizeServer(server));
            } catch {
                // not remembered
            }
            const session = mode === 'signin' ?
                await signIn(server, email, password) :
                await signUp(server, {name, email, password, ...(invite && preview?.valid ? {invite} : {workspaceName: team.trim() || `${name.split(' ')[0] || 'My'}'s team`})});
            onSignedIn(session);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const joining = Boolean(invite && preview?.valid);
    const signupBlocked = mode === 'signup' && !openSignup && !joining;

    return (
        <div className='wash grid h-full place-items-center overflow-y-auto px-6 py-10'>
            <form onSubmit={submit} className='w-full max-w-[380px]'>
                <div data-tauri-drag-region className='mb-7 flex flex-col items-center text-center'>
                    <span className='grid size-16 place-items-center rounded-[22px] bg-white ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)'}}>
                        <img src='/captain-mark.png' alt='' className='size-10'/>
                    </span>
                    <h1 className='mt-5 text-[26px] font-extrabold tracking-tight text-ink'>
                        {joining ? `Join ${preview!.workspaceName}` : mode === 'signin' ? 'Welcome back' : 'Start with Captain'}
                    </h1>
                    <p className='mt-1.5 text-[14px] text-muted'>
                        {joining ? 'Create an account, or sign in if you have one.' : mode === 'signin' ? 'Sign in to your workspace.' : 'Your team and its AI agents, in one chat.'}
                    </p>
                    {invite && preview && !preview.valid && <p className='mt-2 text-[13px] text-alert'>This invite link has expired or been used up.</p>}
                </div>

                <div className='mb-4 flex rounded-full bg-tint p-1'>
                    {(['signin', 'signup'] as const).map((m) => (
                        <button key={m} type='button' onClick={() => setMode(m)} className={`h-8 flex-1 rounded-full text-[13px] font-bold transition-colors ${mode === m ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}>
                            {m === 'signin' ? 'Sign in' : 'Create account'}
                        </button>
                    ))}
                </div>

                <div className='space-y-2.5'>
                    {mode === 'signup' && (
                        <Label text='Your name'><input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete='name' autoFocus/></Label>
                    )}
                    <Label text={mode === 'signin' ? 'Email or username' : 'Work email'}>
                        <input className={field} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete={mode === 'signin' ? 'username' : 'email'} type={mode === 'signin' ? 'text' : 'email'} autoFocus={mode === 'signin'}/>
                    </Label>
                    <Label text='Password'>
                        <input className={field} type='password' value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder={mode === 'signup' ? 'At least 8 characters' : ''}/>
                    </Label>
                    {mode === 'signup' && !joining && openSignup && (
                        <Label text='Team name'><input className={field} value={team} onChange={(e) => setTeam(e.target.value)} placeholder='e.g. Acme Launch Team'/></Label>
                    )}
                </div>

                {signupBlocked && <p className='mt-3 px-1 text-[13px] text-muted'>This server is invite-only. Ask a teammate for an invite link.</p>}
                {error && <p className='mt-3 px-1 text-[13px] text-alert'>{error}</p>}
                <button
                    type='submit'
                    disabled={busy || !email || !password || (mode === 'signup' && (!name || signupBlocked))}
                    className='mt-5 h-11 w-full rounded-full bg-accent text-[14px] font-bold text-on-accent transition-opacity disabled:opacity-50'
                    style={{boxShadow: 'var(--shadow-send)'}}
                >
                    {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : joining ? 'Join workspace' : 'Create account'}
                </button>

                {(isTauri || import.meta.env.DEV) && (
                    <div className='mt-5 text-center text-[12px] text-muted'>
                        {editServer ? (
                            <input className={`${field} h-9 text-[13px]`} value={server} onChange={(e) => setServer(e.target.value)} onBlur={() => setEditServer(false)} autoFocus/>
                        ) : (
                            <button type='button' onClick={() => setEditServer(true)} className='hover:text-ink'>
                                Server: <span className='font-semibold'>{server.replace(/^https?:\/\//, '')}</span> · change
                            </button>
                        )}
                    </div>
                )}
            </form>
        </div>
    );
}
