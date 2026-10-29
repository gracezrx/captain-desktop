// The Mac app's built-in server: first-run setup (the database address) and
// its status while it starts. Shown on the sign-in screen when "This Mac" is
// picked. The server itself is started by the Rust core (src-tauri/src/lib.rs).

import {useEffect, useState} from 'react';

import {errorMessage} from '../lib/api';
import {isTauri, LOCAL_SERVER, localServerForget, localServerRestart, localServerSetup, localServerStatus, type LocalServerStatus, waitForServer} from '../lib/native';

// Polls the server's state while `enabled`; `ready` means it answers requests.
export function useLocalServer(enabled: boolean): {status: LocalServerStatus | null; ready: boolean; refresh: () => void} {
    const [status, setStatus] = useState<LocalServerStatus | null>(null);
    const [ready, setReady] = useState(false);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!enabled || !isTauri) {
            return;
        }
        let stopped = false;
        let timer: number | undefined;
        const poll = async () => {
            const s = await localServerStatus();
            if (stopped) {
                return;
            }
            setStatus(s);
            const up = !!s?.running && (await waitForServer(LOCAL_SERVER, 1500));
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

export function ThisMac({status, onChanged}: {status: LocalServerStatus | null; onChanged: () => void}) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!status) {
        return <p className='py-6 text-center text-[13px] text-muted'>Checking this Mac…</p>;
    }

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await localServerSetup(text);
            setText('');
            setEditing(false);
            onChanged();
        } catch (err) {
            setError(typeof err === 'string' ? err : errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    if (!status.configured || editing) {
        return (
            <form onSubmit={save} className='space-y-3'>
                <p className='px-1 text-[13px] text-muted'>
                    Captain keeps its data in your Postgres database. Paste its address once; it&apos;s saved in your Keychain.
                </p>
                <label className='block'>
                    <span className='mb-1 block px-1 text-[12px] font-semibold text-muted'>Database address</span>
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={3}
                        spellCheck={false}
                        autoFocus
                        placeholder='postgresql://postgres.…@…pooler.supabase.com:5432/postgres'
                        className='w-full resize-none rounded-2xl bg-bg-subtle px-4 py-3 font-mono text-[12.5px] text-ink ring-1 ring-line outline-none placeholder:font-sans placeholder:text-muted focus:ring-2 focus:ring-accent'
                        style={text ? masked : undefined}
                    />
                </label>
                <p className='px-1 text-[12px] text-muted'>
                    In Supabase: Connect → Session pooler, with your password in place of [YOUR-PASSWORD]. You can also paste a whole server <code>.env</code>, which keeps its <code>APP_SECRET</code> so saved model keys still work.
                </p>
                {error && <p className='px-1 text-[13px] text-alert'>{error}</p>}
                <div className='flex gap-2'>
                    <button type='submit' disabled={busy || !text.trim()} className='h-11 flex-1 rounded-full bg-accent text-[14px] font-bold text-on-accent disabled:opacity-50' style={{boxShadow: 'var(--shadow-send)'}}>
                        {busy ? 'One moment…' : 'Start Captain'}
                    </button>
                    {status.configured && (
                        <button type='button' onClick={() => setEditing(false)} className='h-11 rounded-full px-5 text-[13.5px] font-semibold text-text ring-1 ring-line hover:bg-tint'>Cancel</button>
                    )}
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
                    <p className='mt-2 text-[12.5px] text-ink'>The database turned down the password. Change the address and use the current database password.</p>
                )}
            </div>
            <div className='flex gap-2'>
                <button type='button' onClick={() => void localServerRestart().then(onChanged)} className='h-10 flex-1 rounded-full bg-accent text-[13.5px] font-bold text-on-accent'>Try again</button>
                <button type='button' onClick={() => setEditing(true)} className='h-10 flex-1 rounded-full text-[13.5px] font-semibold text-text ring-1 ring-line hover:bg-tint'>Change database address</button>
            </div>
            <button type='button' onClick={() => void localServerForget().then(onChanged)} className='block w-full text-center text-[12px] text-muted hover:text-ink'>Forget this Mac&apos;s server</button>
        </div>
    );
}
