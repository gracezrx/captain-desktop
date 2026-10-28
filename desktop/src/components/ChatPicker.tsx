import {Check, ChevronDown, Search} from 'lucide-react';
import {useEffect, useMemo, useRef, useState} from 'react';

import {useChats} from '../lib/chats';

import {ChatIcon} from './ChatIcon';

type Props = {value: string | null; onChange: (channelId: string) => void};

// "To: Launch room ▾" — pick which chat a message goes to.
export function ChatPicker({value, onChange}: Props) {
    const chats = useChats();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const search = useRef<HTMLInputElement>(null);
    const selected = chats.find((c) => c.channel.id === value);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? chats.filter((c) => c.title.toLowerCase().includes(q) || c.channel.name.toLowerCase().includes(q)) : chats;
    }, [chats, query]);

    useEffect(() => {
        if (open) {
            setQuery('');
            setActive(0);
            requestAnimationFrame(() => search.current?.focus());
        }
    }, [open]);

    const choose = (id: string) => {
        onChange(id);
        setOpen(false);
    };

    return (
        <div className='relative mb-1.5'>
            <button
                type='button'
                onClick={() => setOpen((o) => !o)}
                className='flex h-8 max-w-full items-center gap-2 rounded-full py-1 pr-2.5 pl-1 text-[13px] transition-colors hover:bg-tint'
                aria-haspopup='listbox'
                aria-expanded={open}
            >
                <span className='pl-1.5 text-muted'>To</span>
                {selected ? (
                    <>
                        <ChatIcon channel={selected.channel} size={22}/>
                        <span className='truncate font-semibold text-ink'>{selected.title}</span>
                    </>
                ) : (
                    <span className='font-semibold text-accent-text'>Choose a chat</span>
                )}
                <ChevronDown size={14} className='shrink-0 text-muted'/>
            </button>
            {open && (
                <div className='absolute top-9 right-0 left-0 z-20 overflow-hidden rounded-2xl bg-glass-strong ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)', backdropFilter: 'blur(24px)'}}>
                    <div className='flex items-center gap-2 border-b border-line px-3'>
                        <Search size={14} className='text-muted'/>
                        <input
                            ref={search}
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setActive(0);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setActive((i) => Math.min(i + 1, results.length - 1));
                                } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setActive((i) => Math.max(i - 1, 0));
                                } else if (e.key === 'Enter' && results[active]) {
                                    e.preventDefault();
                                    choose(results[active].channel.id);
                                } else if (e.key === 'Escape') {
                                    e.stopPropagation();
                                    setOpen(false);
                                }
                            }}
                            placeholder='Search chats, people and agents'
                            className='h-10 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted'
                        />
                    </div>
                    <ul role='listbox' className='scroll-quiet max-h-60 overflow-y-auto p-1.5'>
                        {results.map((c, i) => (
                            <li key={c.channel.id} role='option' aria-selected={c.channel.id === value}>
                                <button
                                    type='button'
                                    onMouseEnter={() => setActive(i)}
                                    onClick={() => choose(c.channel.id)}
                                    className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-[13px] ${i === active ? 'bg-tint' : ''}`}
                                >
                                    <ChatIcon channel={c.channel} size={24}/>
                                    <span className='min-w-0 flex-1 truncate font-semibold text-ink'>{c.title}</span>
                                    <span className='text-[11px] text-muted'>{c.kind === 'agent' ? 'Agent' : c.kind === 'dm' ? 'Direct' : 'Channel'}</span>
                                    {c.channel.id === value && <Check size={14} className='text-accent'/>}
                                </button>
                            </li>
                        ))}
                        {results.length === 0 && <li className='px-3 py-4 text-center text-[12.5px] text-muted'>No chats match "{query}"</li>}
                    </ul>
                </div>
            )}
        </div>
    );
}
