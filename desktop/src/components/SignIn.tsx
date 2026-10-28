import {useState} from 'react';

import {DEFAULT_SERVER, errorMessage, type Session, signIn} from '../lib/mm';

export function SignIn({onSignedIn}: {onSignedIn: (s: Session) => void}) {
    const [server, setServer] = useState(DEFAULT_SERVER);
    const [login, setLogin] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            onSignedIn(await signIn(server, login, password));
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const field = 'h-11 w-full rounded-2xl bg-bg-subtle px-4 text-[14px] text-ink ring-1 ring-line outline-none transition-shadow placeholder:text-muted focus:ring-2 focus:ring-accent';

    return (
        <div className='wash grid h-full place-items-center px-6'>
            <form onSubmit={submit} className='w-full max-w-[360px]'>
                <div className='mb-8 flex flex-col items-center text-center'>
                    <span className='grid size-16 place-items-center rounded-[22px] bg-white ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)'}}>
                        <img src='/captain-mark.png' alt='' className='size-10'/>
                    </span>
                    <h1 className='mt-5 text-[26px] font-extrabold tracking-tight text-ink'>Welcome aboard</h1>
                    <p className='mt-1.5 text-[14px] text-muted'>Sign in to your Captain workspace.</p>
                </div>
                <div className='space-y-2.5'>
                    <label className='block'>
                        <span className='mb-1 block px-1 text-[12px] font-semibold text-muted'>Workspace server</span>
                        <input className={field} value={server} onChange={(e) => setServer(e.target.value)} placeholder='https://chat.captainspace.ai' autoComplete='url'/>
                    </label>
                    <label className='block'>
                        <span className='mb-1 block px-1 text-[12px] font-semibold text-muted'>Email or username</span>
                        <input className={field} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete='username' autoFocus/>
                    </label>
                    <label className='block'>
                        <span className='mb-1 block px-1 text-[12px] font-semibold text-muted'>Password</span>
                        <input className={field} type='password' value={password} onChange={(e) => setPassword(e.target.value)} autoComplete='current-password'/>
                    </label>
                </div>
                {error && <p className='mt-3 px-1 text-[13px] text-alert'>{error}</p>}
                <button
                    type='submit'
                    disabled={busy || !login || !password}
                    className='mt-5 h-11 w-full rounded-full bg-accent text-[14px] font-bold text-on-accent transition-opacity disabled:opacity-50'
                    style={{boxShadow: 'var(--shadow-send)'}}
                >
                    {busy ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    );
}
