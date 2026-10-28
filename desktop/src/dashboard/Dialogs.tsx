// Small dialogs: new channel, browse channels, new direct message, search.

import {Hash, Lock, Search} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';

import {Avatar} from '../components/Avatar';
import {ChatIcon} from '../components/ChatIcon';
import {plain} from '../components/Markup';
import {FieldLabel, ghostBtn, input, Modal, primaryBtn} from '../components/Modal';
import {api, errorMessage} from '../lib/api';
import {shortWhen} from '../lib/format';
import {channelTitle, displayName, useStore} from '../lib/store';
import type {Channel, Post} from '../lib/types';

export function NewChannel({onClose}: {onClose: () => void}) {
    const ws = useStore((s) => s.workspace)!;
    const addChannel = useStore((s) => s.addChannel);
    const setActive = useStore((s) => s.setActiveChannel);
    const [name, setName] = useState('');
    const [purpose, setPurpose] = useState('');
    const [priv, setPriv] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const c = await api.createChannel(ws.id, {displayName: name, purpose, type: priv ? 'P' : 'O'});
            addChannel(c);
            setActive(c.id);
            onClose();
        } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    };
    return (
        <Modal title='New channel' onClose={onClose}>
            <form onSubmit={submit} className='space-y-3'>
                <FieldLabel text='Name'><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. Launch room' autoFocus/></FieldLabel>
                <FieldLabel text='What it is for' hint='Agents read this too.'><input className={input} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder='Optional'/></FieldLabel>
                <div className='grid grid-cols-2 gap-2'>
                    {[false, true].map((p) => (
                        <button key={String(p)} type='button' onClick={() => setPriv(p)} className={`flex items-start gap-2 rounded-2xl p-3 text-left ring-1 ${priv === p ? 'bg-tint ring-accent/50' : 'ring-line hover:bg-bg-subtle'}`}>
                            {p ? <Lock size={16} className='mt-0.5 text-accent-text'/> : <Hash size={16} className='mt-0.5 text-accent-text'/>}
                            <span>
                                <span className='block text-[13px] font-bold text-ink'>{p ? 'Private' : 'Public'}</span>
                                <span className='block text-[11.5px] text-muted'>{p ? 'Only people you add' : 'Anyone in the workspace can join'}</span>
                            </span>
                        </button>
                    ))}
                </div>
                {error && <p className='text-[12.5px] text-alert'>{error}</p>}
                <div className='flex justify-end gap-2 pt-1'>
                    <button type='button' className={ghostBtn} onClick={onClose}>Cancel</button>
                    <button type='submit' className={primaryBtn} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create channel'}</button>
                </div>
            </form>
        </Modal>
    );
}

export function BrowseChannels({onClose}: {onClose: () => void}) {
    const ws = useStore((s) => s.workspace)!;
    const mine = useStore((s) => s.channels);
    const addChannel = useStore((s) => s.addChannel);
    const setActive = useStore((s) => s.setActiveChannel);
    const [list, setList] = useState<Channel[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        api.browseChannels(ws.id).then(setList).catch((e) => setError(errorMessage(e)));
    }, [ws.id]);
    const open = async (c: Channel) => {
        try {
            if (!mine[c.id]) {
                addChannel(await api.joinChannel(c.id));
            }
            setActive(c.id);
            onClose();
        } catch (e) {
            setError(errorMessage(e));
        }
    };
    return (
        <Modal title='Channels' onClose={onClose}>
            {error && <p className='mb-2 text-[12.5px] text-alert'>{error}</p>}
            {!list && !error && <p className='py-6 text-center text-[13px] text-muted'>Loading…</p>}
            {list?.length === 0 && <p className='py-6 text-center text-[13px] text-muted'>No public channels yet.</p>}
            <div className='space-y-1'>
                {list?.map((c) => (
                    <button key={c.id} type='button' onClick={() => void open(c)} className='flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left hover:bg-tint'>
                        <ChatIcon channel={c} size={30}/>
                        <span className='min-w-0 flex-1'>
                            <span className='block truncate text-[13.5px] font-bold text-ink'>{c.displayName}</span>
                            <span className='block truncate text-[12px] text-muted'>{c.purpose || `#${c.name}`}</span>
                        </span>
                        <span className={`text-[12px] font-semibold ${mine[c.id] ? 'text-muted' : 'text-accent-text'}`}>{mine[c.id] ? 'Joined' : 'Join'}</span>
                    </button>
                ))}
            </div>
        </Modal>
    );
}

export function NewMessage({onClose}: {onClose: () => void}) {
    const ws = useStore((s) => s.workspace)!;
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me);
    const addChannel = useStore((s) => s.addChannel);
    const setActive = useStore((s) => s.setActiveChannel);
    const [q, setQ] = useState('');
    const [error, setError] = useState<string | null>(null);
    const people = useMemo(() => Object.values(users).
        filter((u) => u.id !== me?.id && (!q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.username.includes(q.toLowerCase()))).
        sort((a, b) => Number(a.isBot) - Number(b.isBot) || a.displayName.localeCompare(b.displayName)), [users, me, q]);
    const open = async (userId: string) => {
        try {
            const c = await api.directMessage(ws.id, userId);
            addChannel(c);
            setActive(c.id);
            onClose();
        } catch (e) {
            setError(errorMessage(e));
        }
    };
    return (
        <Modal title='New message' onClose={onClose}>
            <input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder='Find a person or agent' autoFocus/>
            {error && <p className='mt-2 text-[12.5px] text-alert'>{error}</p>}
            <div className='mt-2 space-y-0.5'>
                {people.map((u) => (
                    <button key={u.id} type='button' onClick={() => void open(u.id)} className='flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left hover:bg-tint'>
                        <Avatar user={u} size={28}/>
                        <span className='min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink'>{displayName(u)}</span>
                        <span className='text-[12px] text-muted'>{u.isBot ? 'Agent' : `@${u.username}`}</span>
                    </button>
                ))}
                {people.length === 0 && <p className='py-4 text-center text-[13px] text-muted'>No one matches. Invite people from Settings.</p>}
            </div>
        </Modal>
    );
}

export function SearchMessages({onClose, onOpen}: {onClose: () => void; onOpen: (p: Post) => void}) {
    const ws = useStore((s) => s.workspace)!;
    const users = useStore((s) => s.users);
    const channels = useStore((s) => s.channels);
    const me = useStore((s) => s.me);
    const [q, setQ] = useState('');
    const [results, setResults] = useState<Post[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!q.trim()) {
            setResults(null);
            return undefined;
        }
        const t = window.setTimeout(() => {
            api.search(ws.id, q).then(setResults).catch((e) => setError(errorMessage(e)));
        }, 250);
        return () => clearTimeout(t);
    }, [q, ws.id]);
    return (
        <Modal title='Search messages' onClose={onClose} width={560}>
            <label className='flex items-center gap-2'>
                <Search size={16} className='text-muted'/>
                <input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder='Words, names, numbers…' autoFocus/>
            </label>
            {error && <p className='mt-2 text-[12.5px] text-alert'>{error}</p>}
            <div className='mt-3 space-y-1'>
                {results?.map((p) => (
                    <button key={p.id} type='button' onClick={() => onOpen(p)} className='flex w-full items-start gap-3 rounded-2xl px-2.5 py-2 text-left hover:bg-tint'>
                        <Avatar user={users[p.userId]} size={28}/>
                        <span className='min-w-0 flex-1'>
                            <span className='flex items-baseline gap-2 text-[12px] text-muted'>
                                <span className='font-bold text-ink'>{displayName(users[p.userId])}</span>
                                <span>in {channelTitle(channels[p.channelId], me?.id, users) || 'a chat'}</span>
                                <span className='ml-auto'>{shortWhen(p.createdAt)}</span>
                            </span>
                            <span className='line-clamp-2 text-[13px] text-text'>{plain(p.message)}</span>
                        </span>
                    </button>
                ))}
                {results?.length === 0 && <p className='py-6 text-center text-[13px] text-muted'>Nothing found.</p>}
            </div>
        </Modal>
    );
}
