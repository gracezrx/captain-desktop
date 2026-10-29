// The Mac app's built-in server: first-run setup (the database address) and
// its status while it starts. Shown on the sign-in screen when "This Mac" is
// picked. The server itself is started by the Rust core (src-tauri/src/lib.rs).

import {useEffect, useState} from 'react';

import {errorMessage} from '../lib/api';
import {type FoundServerSettings, isExtension, isTauri, LOCAL_SERVER, localServerFound, localServerForget, localServerRestart, localServerSetup, localServerStatus, type LocalServerStatus, localServerUseFound, waitForServer} from '../lib/native';

// Polls the server's state while `enabled`; `ready` means it answers requests.
export function useLocalServer(enabled: boolean): {status: LocalServerStatus | null; ready: boolean; refresh: () => void} {
    const [status, setStatus] = useState<LocalServerStatus | null>(null);
    const [ready, setReady] = useState(false);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!enabled || !(isTauri || isExtension)) {
            return;
        }
        let stopped = false;
        let timer: number | undefined;
        const poll = async () => {
            // The extension can't see the app, only whether its server answers.
            const s = isTauri ? await localServerStatus() : null;
            if (stopped) {
                return;
            }
            setStatus(s);
            const up = (isExtension || !!s?.running) && (await waitForServer(LOCAL_SERVER, 1500));
            if (stopped) {
                return;
            }
            setReady(up);
            if (!up) {
                timer = window.setTimeout(() => void poll(), 1000);
            }
        };
        void poll();
        return () => {
            stopped = true;
            window.clearTimeout(timer);
        };
    }, [enabled, tick]);

    return {status, ready, refresh: () => setTick((t) => t + 1)};
}

const masked = {WebkitTextSecurity: 'disc'} as React.CSSProperties;

// Has a password in it already (or is a whole .env).
const hasPassword = (t: string) => /^DATABASE_URL=/m.test(t.trim()) || /:\/\/[^:@/\s]+:(?!\[YOUR-PASSWORD\])[^@\s]+@/.test(t);

export function ThisMac({status, onChanged}: {status: LocalServerStatus | null; onChanged: () => void}) {
    const [editing, setEditing] = useState(false);
    const [manual, setManual] = useState(false);
    const [found, setFound] = useState<FoundServerSettings[] | null>(null);
    const [text, setText] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const setup = !!status && (!status.configured || editing);

    // A server you ran before: offer its database, so there's nothing to paste.
    useEffect(() => {
        if (setup) {
            void localServerFound().then(setFound);
        }
    }, [setup]);

    if (!status) {
        return <p className='py-6 text-center text-[13px] text-muted'>Checking this Mac…</p>;
    }

    const run = async (what: string, act: () => Promise<void>) => {
        setBusy(what);
        setError(null);
        try {
            await act();
            setText('');
            setPassword('');
            setEditing(false);
            setManual(false);
            onChanged();
        } catch (err) {
            setError(typeof err === 'string' ? err : errorMessage(err));
        } finally {
            setBusy(null);
        }
    };

    const cancel = status.configured && (
        <button type='button' onClick={() => {
            setEditing(false);
            setManual(false);
            setError(null);
        }} className='h-11 rounded-full px-5 text-[13.5px] font-semibold text-text ring-1 ring-line hover:bg-tint'>Cancel</button>
    );

    if (setup && found === null) {
        return (
            <div className='space-y-2 py-4 text-center'>
                <p className='text-[13px] text-muted'>Looking for your Supabase settings…</p>
                <p className='text-[12px] text-muted'>If your Mac asks, allow Captain to read your Documents folder.</p>
            </div>
        );
    }

    if (setup && found && found.length > 0 && !manual) {
        return (
            <div className='space-y-3'>
                <p className='px-1 text-[13px] text-muted'>
                    Captain found the settings of a Captain server you ran before. Connect to the same Supabase database; nothing to paste.
                </p>
                {found.map((f) => (
                    <div key={f.path} className='rounded-2xl bg-bg-subtle p-4 ring-1 ring-line'>
                        <div className='text-[12px] font-semibold text-muted'>Your Supabase project</div>
                        <div className='mt-0.5 truncate font-mono text-[14px] font-bold text-ink'>{f.project}</div>
                        <div className='mt-1 text-[12px] text-muted'>
                            From <span className='font-mono'>{f.path}</span>{f.keepsKeys ? '. Model keys saved there keep working.' : '.'}
                        </div>
                        <button
                            type='button'
                            disabled={busy !== null}
                            onClick={() => void run(f.path, () => localServerUseFound(f.path))}
                            className='mt-3 h-11 w-full rounded-full bg-accent text-[14px] font-bold text-on-accent disabled:opacity-50'
                            style={{boxShadow: 'var(--shadow-send)'}}
                        >
                            {busy === f.path ? 'Connecting…' : 'Connect'}
                        </button>
                    </div>
                ))}
                {error && <p className='px-1 text-[13px] text-alert'>{error}</p>}
                <div className='flex items-center gap-2'>
                    <button type='button' onClick={() => {
                        setManual(true);
                        setError(null);
                    }} className='h-11 flex-1 rounded-full text-[13px] font-semibold text-muted hover:text-ink'>Use a different database</button>
                    {cancel}
                </div>
            </div>
        );
    }

    if (setup) {
        const withEnv = /^DATABASE_URL=/m.test(text.trim());
        const needsPassword = text.includes('[YOUR-PASSWORD]') && !password;
        return (
            <form onSubmit={(e) => {
                e.preventDefault();
                void run('manual', () => localServerSetup(text, withEnv ? '' : password));
            }} className='space-y-3'>
                <p className='px-1 text-[13px] text-muted'>
                    Captain keeps its data in your Postgres database, like a Supabase project. Enter it once; it stays on this Mac.
                </p>
                <label className='block'>
                    <span className='mb-1 block px-1 text-[12px] font-semibold text-muted'>Database address</span>
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={3}
                        spellCheck={false}
                        autoFocus
                        placeholder='postgresql://postgres.…:[YOUR-PASSWORD]@…pooler.supabase.com:5432/postgres'
                        className='w-full resize-none rounded-2xl bg-bg-subtle px-4 py-3 font-mono text-[12.5px] text-ink ring-1 ring-line outline-none placeholder:font-sans placeholder:text-muted focus:ring-2 focus:ring-accent'
                        style={hasPassword(text) ? masked : undefined}
                    />
                </label>
                <p className='px-1 text-[12px] text-muted'>
                    In Supabase: Connect → Session pooler, and copy the address as it is. You can also paste a whole server <code>.env</code>, which keeps its <code>APP_SECRET</code> so saved model keys still work.
                </p>
                {!withEnv && (
                    <label className='block'>
                        <span className='mb-1 block px-1 text-[12px] font-semibold text-muted'>Database password</span>
                        <input
                            type='password'
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete='off'
                            placeholder={hasPassword(text) ? 'Already in the address' : 'The one you set for the project'}
                            className='h-11 w-full rounded-2xl bg-bg-subtle px-4 text-[13.5px] text-ink ring-1 ring-line outline-none placeholder:text-muted focus:ring-2 focus:ring-accent'
                        />
                        <span className='mt-1 block px-1 text-[12px] text-muted'>Forgot it? Supabase → Project Settings → Database → Reset database password.</span>
                    </label>
                )}
                {error && <p className='px-1 text-[13px] text-alert'>{error}</p>}
                <div className='flex gap-2'>
                    <button type='submit' disabled={busy !== null || !text.trim() || needsPassword} className='h-11 flex-1 rounded-full bg-accent text-[14px] font-bold text-on-accent disabled:opacity-50' style={{boxShadow: 'var(--shadow-send)'}}>
                        {busy ? 'One moment…' : 'Start Captain'}
                    </button>
                    {found && found.length > 0 ? (
                        <button type='button' onClick={() => {
                            setManual(false);
                            setError(null);
                        }} className='h-11 rounded-full px-5 text-[13.5px] font-semibold text-text ring-1 ring-line hover:bg-tint'>Back</button>
                    ) : cancel}
                </div>
            </form>
        );
    }

    if (status.starting || (status.running && !status.error)) {
        return (
            <div className='flex items-center justify-center gap-2.5 py-6 text-[13.5px] text-muted'>
                <span className='size-2 animate-pulse rounded-full bg-accent'/> Starting Captain on this Mac…
            </div>
        );
    }

    return (
        <div className='space-y-3'>
            <div className='rounded-2xl bg-bg-subtle p-3.5 ring-1 ring-line'>
                <p className='text-[13.5px] font-semibold text-alert'>{status.error ?? 'Captain isn\'t running on this Mac.'}</p>
                {status.log && <pre className='scroll-quiet mt-2 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted'>{status.log}</pre>}
                {status.log && /password authentication failed/.test(status.log) && (
                    <p className='mt-2 text-[12.5px] text-ink'>The database turned down the password. Choose Change database and enter the current database password.</p>
                )}
            </div>
            <div className='flex gap-2'>
                <button type='button' onClick={() => void localServerRestart().then(onChanged)} className='h-10 flex-1 rounded-full bg-accent text-[13.5px] font-bold text-on-accent'>Try again</button>
                <button type='button' onClick={() => setEditing(true)} className='h-10 flex-1 rounded-full text-[13.5px] font-semibold text-text ring-1 ring-line hover:bg-tint'>Change database</button>
            </div>
            <button type='button' onClick={() => void localServerForget().then(onChanged)} className='block w-full text-center text-[12px] text-muted hover:text-ink'>Forget this Mac&apos;s server</button>
        </div>
    );
}
