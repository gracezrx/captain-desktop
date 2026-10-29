import {useEffect, useState} from 'react';

import {confirmPasswordReset, DEFAULT_SERVER, errorMessage, invitePreview, normalizeServer, requestPasswordReset, serverConfig, signIn, signUp, type StoredSession} from '../lib/api';
import {isExtension, isTauri, LOCAL_SERVER} from '../lib/native';
import type {InvitePreview} from '../lib/types';

import {ThisMac, useLocalServer} from './ThisMac';

export const field = 'h-11 w-full rounded-2xl bg-bg-subtle px-4 text-[14px] text-ink ring-1 ring-line outline-none transition-shadow placeholder:text-muted focus:ring-2 focus:ring-accent';

function param(name: string): string {
    try {
        return new URLSearchParams(location.search).get(name) ?? '';
    } catch {
        return '';
    }
}

export function inviteFromUrl(): string {
    return param('invite');
}

function clearParam(name: string): void {
    try {
        const url = new URL(location.href);
        url.searchParams.delete(name);
        history.replaceState(null, '', url.toString());
    } catch {
        // nothing to clear
    }
}

type Mode = 'signin' | 'signup' | 'forgot' | 'reset';

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
    const resetToken = param('reset');
    const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : invite ? 'signup' : 'signin');
    const [emailEnabled, setEmailEnabled] = useState(true);
    const [sent, setSent] = useState(false);
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
    const onThisMac = (isTauri || isExtension) && server === LOCAL_SERVER;
    const local = useLocalServer(onThisMac);

    useEffect(() => {
        if (onThisMac && !local.ready) {
            return;
        }
        serverConfig(server).then((c) => {
            setOpenSignup(c.openSignup);
            setEmailEnabled(c.emailEnabled);
        }).catch(() => undefined);
        if (invite) {
            invitePreview(server, invite).then(setPreview).catch(() => undefined);
        }
    }, [server, invite, onThisMac, local.ready]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        // The extension may talk only to servers Chrome has let it reach: ask
        // now, while this counts as a click.
        if (isExtension && !(await allowServer(normalizeServer(server)))) {
            setError('Captain needs permission to reach that server.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            try {
                localStorage.setItem('captain.server', normalizeServer(server));
            } catch {
                // not remembered
            }
            if (mode === 'forgot') {
                await requestPasswordReset(server, email);
                setSent(true);
                return;
            }
            if (mode === 'reset') {
                const session = await confirmPasswordReset(server, resetToken, password);
                clearParam('reset');
                onSignedIn(session);
                return;
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

    const recovering = mode === 'forgot' || mode === 'reset';
    const title = mode === 'reset' ? 'Choose a new password' : mode === 'forgot' ? 'Reset your password' : joining ? `Join ${preview!.workspaceName}` : mode === 'signin' ? 'Welcome back' : 'Start with Captain';
    const subtitle = mode === 'reset' ? 'You\'ll be signed in here and signed out everywhere else.' :
        mode === 'forgot' ? (emailEnabled ? 'We\'ll email you a link that works for an hour.' : 'This server can\'t send email yet. Ask a workspace admin for a reset link (Settings → People).') :
        joining ? 'Create an account, or sign in if you have one.' : mode === 'signin' ? 'Sign in to your workspace.' : 'Your team and its AI agents, in one chat.';
    const disabled = busy || (mode === 'forgot' ? !email || !emailEnabled : mode === 'reset' ? password.length < 8 : !email || !password || (mode === 'signup' && (!name || signupBlocked)));
    const label = busy ? 'One moment…' : mode === 'forgot' ? 'Email me a link' : mode === 'reset' ? 'Set password and sign in' : mode === 'signin' ? 'Sign in' : joining ? 'Join workspace' : 'Create account';

    const where = !recovering && (isTauri || isExtension ? (
        <Where server={server} setServer={setServer}/>
    ) : import.meta.env.DEV ? (
        <div className='mt-5 text-center text-[12px] text-muted'>
            {editServer ? (
                <input className={`${field} h-9 text-[13px]`} value={server} onChange={(e) => setServer(e.target.value)} onBlur={() => setEditServer(false)} autoFocus/>
            ) : (
                <button type='button' onClick={() => setEditServer(true)} className='hover:text-ink'>
                    Server: <span className='font-semibold'>{server.replace(/^https?:\/\//, '')}</span> · change
                </button>
            )}
        </div>
    ) : null);

    // The Mac app's own server isn't up yet: set it up, or wait for it.
    if (onThisMac && !local.ready && !recovering) {
        return (
            <div className='wash grid h-full place-items-center overflow-y-auto px-6 py-10'>
                <div className='w-full max-w-[380px]'>
                    <div data-tauri-drag-region className='mb-7 flex flex-col items-center text-center'>
                        <span className='grid size-16 place-items-center rounded-[22px] bg-white ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)'}}>
                            <img src='/captain-mark.png' alt='' className='size-10'/>
                        </span>
                        <h1 className='mt-5 text-[26px] font-extrabold tracking-tight text-ink'>{local.status && !local.status.configured ? 'Run Captain on this Mac' : 'Captain on this Mac'}</h1>
                        <p className='mt-1.5 text-[14px] text-muted'>Everything runs here; no terminal needed.</p>
                    </div>
                    {isExtension ? (
                        <p className='rounded-2xl bg-bg-subtle px-4 py-3 text-center text-[13.5px] text-muted ring-1 ring-line'>
                            Open the Captain app on your Mac. This extension connects to it as soon as it&apos;s running.
                        </p>
                    ) : (
                        <ThisMac status={local.status} onChanged={local.refresh}/>
                    )}
                    {where}
                </div>
            </div>
        );
    }

    return (
        <div className='wash grid h-full place-items-center overflow-y-auto px-6 py-10'>
            <form onSubmit={submit} className='w-full max-w-[380px]'>
                <div data-tauri-drag-region className='mb-7 flex flex-col items-center text-center'>
                    <span className='grid size-16 place-items-center rounded-[22px] bg-white ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)'}}>
                        <img src='/captain-mark.png' alt='' className='size-10'/>
                    </span>
                    <h1 className='mt-5 text-[26px] font-extrabold tracking-tight text-ink'>{title}</h1>
                    <p className='mt-1.5 text-[14px] text-muted'>{subtitle}</p>
                    {invite && preview && !preview.valid && !recovering && <p className='mt-2 text-[13px] text-alert'>This invite link has expired or been used up.</p>}
                </div>

                {!recovering && (
                    <div className='mb-4 flex rounded-full bg-tint p-1'>
                        {(['signin', 'signup'] as const).map((m) => (
                            <button key={m} type='button' onClick={() => setMode(m)} className={`h-8 flex-1 rounded-full text-[13px] font-bold transition-colors ${mode === m ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}>
                                {m === 'signin' ? 'Sign in' : 'Create account'}
                            </button>
                        ))}
                    </div>
                )}

                {mode === 'forgot' && sent ? (
                    <p className='rounded-2xl bg-tint px-4 py-3 text-[13.5px] text-ink'>If that email has an account, a reset link is on its way. It works for an hour.</p>
                ) : (
                    <div className='space-y-2.5'>
                        {mode === 'signup' && (
                            <Label text='Your name'><input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete='name' autoFocus/></Label>
                        )}
                        {mode !== 'reset' && (
                            <Label text={mode === 'signin' ? 'Email or username' : 'Work email'}>
                                <input className={field} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete={mode === 'signin' ? 'username' : 'email'} type={mode === 'signin' ? 'text' : 'email'} autoFocus={mode === 'signin' || mode === 'forgot'}/>
                            </Label>
                        )}
                        {mode !== 'forgot' && (
                            <Label text={mode === 'reset' ? 'New password' : 'Password'}>
                                <input className={field} type='password' value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder={mode === 'signup' || mode === 'reset' ? 'At least 8 characters' : ''} autoFocus={mode === 'reset'}/>
                            </Label>
                        )}
                        {mode === 'signin' && (
                            <div className='px-1 text-right'>
                                <button type='button' onClick={() => {
                                    setMode('forgot');
                                    setError(null);
                                    setSent(false);
                                }} className='text-[12.5px] font-semibold text-accent-text hover:underline'>Forgot password?</button>
                            </div>
                        )}
                        {mode === 'signup' && !joining && openSignup && (
                            <Label text='Team name'><input className={field} value={team} onChange={(e) => setTeam(e.target.value)} placeholder='e.g. Acme Launch Team'/></Label>
                        )}
                    </div>
                )}

                {signupBlocked && <p className='mt-3 px-1 text-[13px] text-muted'>This server is invite-only. Ask a teammate for an invite link.</p>}
                {error && <p className='mt-3 px-1 text-[13px] text-alert'>{error}</p>}
                {!(mode === 'forgot' && sent) && (
                    <button
                        type='submit'
                        disabled={disabled}
                        className='mt-5 h-11 w-full rounded-full bg-accent text-[14px] font-bold text-on-accent transition-opacity disabled:opacity-50'
                        style={{boxShadow: 'var(--shadow-send)'}}
                    >
                        {label}
                    </button>
                )}
                {recovering && (
                    <div className='mt-4 text-center'>
                        <button type='button' onClick={() => {
                            clearParam('reset');
                            setMode('signin');
                            setError(null);
                            setPassword('');
                        }} className='text-[12.5px] font-semibold text-muted hover:text-ink'>Back to sign in</button>
                    </div>
                )}

                {where}
            </form>
        </div>
    );
}

async function allowServer(url: string): Promise<boolean> {
    try {
        const origins = [`${new URL(url).origin}/*`];
        return (await chrome.permissions.contains({origins})) || (await chrome.permissions.request({origins}));
    } catch {
        return false;
    }
}

// In the Mac app: run Captain here, or use a hosted Captain server.
// In the extension: the app on this Mac, or a hosted Captain server.
function Where({server, setServer}: {server: string; setServer: (s: string) => void}) {
    const here = server === LOCAL_SERVER;
    const [edit, setEdit] = useState(false);
    const remembered = () => {
        try {
            return localStorage.getItem('captain.remoteServer') ?? '';
        } catch {
            return '';
        }
    };
    const remember = (url: string) => {
        try {
            localStorage.setItem('captain.remoteServer', url);
        } catch {
            // not remembered
        }
    };
    const pill = (on: boolean) => `h-7 rounded-full px-3.5 transition-colors ${on ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`;
    return (
        <div className='mt-6 flex flex-col items-center gap-2 text-[12px] text-muted'>
            <div className='inline-flex items-center gap-1 rounded-full bg-tint p-1 font-bold'>
                <button type='button' className={pill(here)} onClick={() => setServer(LOCAL_SERVER)}>This Mac</button>
                <button type='button' className={pill(!here)} onClick={() => {
                    const r = remembered();
                    setServer(r);
                    setEdit(!r);
                }}>A Captain server</button>
            </div>
            {!here && (edit ? (
                <input
                    className={`${field} h-9 text-[13px]`}
                    value={server}
                    placeholder='captain.example.com'
                    onChange={(e) => setServer(e.target.value)}
                    onBlur={() => {
                        remember(server.trim());
                        setEdit(false);
                    }}
                    autoFocus
                />
            ) : (
                <button type='button' onClick={() => setEdit(true)} className='hover:text-ink'>
                    <span className='font-semibold'>{server.replace(/^https?:\/\//, '') || 'Add an address'}</span> · change
                </button>
            ))}
        </div>
    );
}
