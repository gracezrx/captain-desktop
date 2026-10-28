import {Command, LogOut, Search} from 'lucide-react';
import {useMemo, useState} from 'react';

import {Avatar} from '../components/Avatar';
import {ChatIcon} from '../components/ChatIcon';
import {type ChatEntry, useChats} from '../lib/chats';
import {channelTitle, decisionOf, displayName, needsYou, useStore} from '../lib/store';

export function Sidebar({onSignOut}: {onSignOut: () => void}) {
    const chats = useChats();
    const me = useStore((s) => s.me);
    const team = useStore((s) => s.team);
    const connection = useStore((s) => s.connection);
    const active = useStore((s) => s.activeChannelId);
    const setActive = useStore((s) => s.setActiveChannel);
    const channels = useStore((s) => s.channels);
    const members = useStore((s) => s.members);
    const posts = useStore((s) => s.posts);
    const postsByChannel = useStore((s) => s.postsByChannel);
    const users = useStore((s) => s.users);
    const [query, setQuery] = useState('');

    const waiting = useMemo(() => needsYou({channels, members, posts, postsByChannel, me, users}), [channels, members, posts, postsByChannel, me, users]);
    const q = query.trim().toLowerCase();
    const visible = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
    const sections: [string, ChatEntry[]][] = [
        ['Agents', visible.filter((c) => c.kind === 'agent')],
        ['Channels', visible.filter((c) => c.kind === 'channel')],
        ['Direct messages', visible.filter((c) => c.kind === 'dm')],
    ];

    return (
        <aside className='flex w-[268px] shrink-0 flex-col border-r border-nav-line bg-rail'>
            {/* room for the macOS traffic lights; drag the window from here */}
            <div data-tauri-drag-region className='h-11 shrink-0'/>
            <div className='flex items-center gap-2.5 px-4 pb-3'>
                <span className='grid size-9 place-items-center rounded-xl bg-white ring-1 ring-nav-line' style={{boxShadow: 'var(--shadow-control)'}}>
                    <img src='/captain-mark.png' alt='' className='size-6'/>
                </span>
                <div className='min-w-0'>
                    <div className='truncate text-[15px] font-extrabold tracking-tight text-nav-text'>{team?.display_name ?? 'Captain'}</div>
                    <div className='text-[11.5px] text-nav-muted'>Captain workspace</div>
                </div>
            </div>
            <div className='px-3 pb-2'>
                <label className='flex h-9 items-center gap-2 rounded-xl bg-white/70 px-3 text-nav-muted ring-1 ring-nav-line focus-within:ring-accent dark:bg-white/5'>
                    <Search size={14}/>
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='Find a chat' className='min-w-0 flex-1 bg-transparent text-[13px] text-nav-text outline-none placeholder:text-nav-muted'/>
                </label>
            </div>

            <nav className='scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3'>
                {waiting.length > 0 && !q && (
                    <section className='mb-2'>
                        <h2 className='flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11.5px] font-bold text-gold-text'>
                            <span className='size-1.5 rounded-full bg-gold'/>
                            Needs you · {waiting.length}
                        </h2>
                        {waiting.slice(0, 5).map((item) => {
                            const channel = channels[item.channelId];
                            const post = item.postId ? posts[item.postId] : undefined;
                            const d = decisionOf(post);
                            const who = post ? displayName(users[post.user_id]) : '';
                            const line = d ? d.title : item.kind === 'dm' ? post?.message || 'New message' : `${who} mentioned you`;
                            return (
                                <button
                                    key={`${item.channelId}:${item.postId}`}
                                    type='button'
                                    onClick={() => setActive(item.channelId)}
                                    className='mb-1 flex w-full items-start gap-2.5 rounded-xl bg-white/80 px-2.5 py-2 text-left ring-1 ring-nav-line transition-colors hover:bg-white dark:bg-white/5'
                                >
                                    <ChatIcon channel={channel} size={24}/>
                                    <span className='min-w-0 flex-1'>
                                        <span className='block truncate text-[12.5px] font-bold text-nav-text'>{channelTitle(channel, me?.id, users)}</span>
                                        <span className='block truncate text-[12px] text-nav-muted'>{d ? `Decision · ${line}` : line}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </section>
                )}
                {sections.map(([label, list]) => list.length > 0 && (
                    <section key={label} className='mb-1'>
                        <h2 className='px-2.5 pt-3 pb-1 text-[11.5px] font-bold text-nav-muted'>{label}</h2>
                        {list.map((c) => (
                            <ChatRow key={c.channel.id} chat={c} active={c.channel.id === active} onClick={() => setActive(c.channel.id)}/>
                        ))}
                    </section>
                ))}
            </nav>

            <div className='flex items-center gap-2.5 border-t border-nav-line px-3.5 py-3'>
                <span className='relative'>
                    <Avatar user={me ?? undefined} size={30}/>
                    <span className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-[var(--rail-bg)] ${connection === 'online' ? 'bg-emerald-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-slate-400'}`}/>
                </span>
                <div className='min-w-0 flex-1'>
                    <div className='truncate text-[13px] font-bold text-nav-text'>{displayName(me ?? undefined)}</div>
                    <div className='flex items-center gap-1 text-[11px] text-nav-muted'>
                        <Command size={11}/> quick panel: ⌥⇧Space
                    </div>
                </div>
                <button type='button' onClick={onSignOut} aria-label='Sign out' title='Sign out' className='grid size-8 place-items-center rounded-full text-nav-muted hover:bg-white/70 hover:text-nav-text dark:hover:bg-white/10'>
                    <LogOut size={15}/>
                </button>
            </div>
        </aside>
    );
}

function ChatRow({chat, active, onClick}: {chat: ChatEntry; active: boolean; onClick: () => void}) {
    const bold = chat.unread > 0;
    return (
        <button
            type='button'
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            className={`mb-px flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${active ? 'bg-[var(--active-chat)] ring-1 ring-nav-line' : 'hover:bg-white/60 dark:hover:bg-white/5'}`}
            style={active ? {boxShadow: 'var(--shadow-control)'} : undefined}
        >
            <ChatIcon channel={chat.channel} size={26}/>
            <span className={`min-w-0 flex-1 truncate text-[13.5px] ${bold || active ? 'font-bold text-nav-text' : 'font-medium text-nav-muted'}`}>{chat.title}</span>
            {chat.mentions > 0 ? (
                <span className='min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] leading-5 font-bold text-on-accent'>{chat.mentions}</span>
            ) : bold ? (
                <span className='size-2 rounded-full bg-accent'/>
            ) : null}
        </button>
    );
}
