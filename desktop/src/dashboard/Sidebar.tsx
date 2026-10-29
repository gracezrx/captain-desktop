import {Check, ChevronDown, Keyboard, LayoutDashboard, LogOut, Plus, Search, Settings as Gear, TextSearch} from 'lucide-react';
import {useMemo, useState} from 'react';

import {Avatar, portraitSrc} from '../components/Avatar';
import {ChatIcon} from '../components/ChatIcon';
import {plain} from '../components/Markup';
import {api, errorMessage} from '../lib/api';
import {isTauri} from '../lib/native';
import {type ChatEntry, useChats} from '../lib/chats';
import {useShortcutLabels} from '../lib/shortcuts';
import {channelTitle, decisionOf, displayName, needsYou, otherUserId, useStore} from '../lib/store';
import type {Agent} from '../lib/types';

export type SidebarAction = 'new-channel' | 'browse' | 'new-dm' | 'settings' | 'invite' | 'new-workspace' | 'search' | 'models';

export function Sidebar({onSignOut, onAction}: {onSignOut: () => void; onAction: (a: SidebarAction) => void}) {
    const chats = useChats();
    const me = useStore((s) => s.me);
    const keys = useShortcutLabels();
    const workspace = useStore((s) => s.workspace);
    const workspaces = useStore((s) => s.workspaces);
    const switchWorkspace = useStore((s) => s.switchWorkspace);
    const connection = useStore((s) => s.connection);
    const active = useStore((s) => s.activeChannelId);
    const setActive = useStore((s) => s.setActiveChannel);
    const channels = useStore((s) => s.channels);
    const members = useStore((s) => s.members);
    const posts = useStore((s) => s.posts);
    const postsByChannel = useStore((s) => s.postsByChannel);
    const users = useStore((s) => s.users);
    const agents = useStore((s) => s.agents);
    const addChannel = useStore((s) => s.addChannel);
    const [query, setQuery] = useState('');
    const [menu, setMenu] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const waiting = useMemo(() => needsYou({channels, members, posts, postsByChannel, me, workspace}), [channels, members, posts, postsByChannel, me, workspace]);
    const q = query.trim().toLowerCase();
    const match = (t: string) => !q || t.toLowerCase().includes(q);

    // Every agent is listed, whether or not you've talked to it yet.
    const agentRows = useMemo(() => {
        const dmByUser = new Map(chats.filter((c) => c.channel.type === 'D').map((c) => [otherUserId(c.channel, me?.id ?? ''), c]));
        return Object.values(agents).filter((a) => a.enabled && match(a.name)).
            sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator) || a.name.localeCompare(b.name)).
            map((a) => ({agent: a, chat: dmByUser.get(a.userId)}));
    }, [agents, chats, me, q]); // eslint-disable-line react-hooks/exhaustive-deps

    const openAgent = async (a: Agent, chat?: ChatEntry) => {
        if (chat) {
            setActive(chat.channel.id);
            return;
        }
        try {
            const c = await api.directMessage(workspace!.id, a.userId);
            addChannel(c);
            setActive(c.id);
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    const channelsList = chats.filter((c) => c.kind === 'channel' && match(c.title));
    const dms = chats.filter((c) => c.kind === 'dm' && match(c.title));

    return (
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-nav-line bg-rail'>
            {/* room for the macOS traffic lights; drag the window from here */}
            <div data-tauri-drag-region className='h-11 shrink-0'/>
            <div className='relative px-3 pb-2.5'>
                <button type='button' onClick={() => setMenu((m) => !m)} className='flex w-full items-center gap-2.5 rounded-2xl px-1.5 py-1 text-left hover:bg-white/60 dark:hover:bg-white/5'>
                    <span className='grid size-9 place-items-center rounded-xl bg-white ring-1 ring-nav-line' style={{boxShadow: 'var(--shadow-control)'}}>
                        <img src='/captain-mark.png' alt='' className='size-6'/>
                    </span>
                    <span className='min-w-0 flex-1'>
                        <span className='block truncate text-[15px] font-extrabold tracking-tight text-nav-text'>{workspace?.name ?? 'Captain'}</span>
                        <span className='block text-[11.5px] text-nav-muted capitalize'>{workspace?.role ?? ''} · Captain</span>
                    </span>
                    <ChevronDown size={15} className='text-nav-muted'/>
                </button>
                {menu && (
                    <>
                        <div className='fixed inset-0 z-20' onClick={() => setMenu(false)}/>
                        <div className='absolute top-12 right-3 left-3 z-30 overflow-hidden rounded-2xl bg-glass-strong p-1.5 ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)', backdropFilter: 'blur(24px)'}}>
                            {workspaces.map((w) => (
                                <button key={w.id} type='button' onClick={() => {
                                    setMenu(false);
                                    void switchWorkspace(w.id);
                                }} className='flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-semibold text-ink hover:bg-tint'>
                                    <span className='min-w-0 flex-1 truncate'>{w.name}</span>
                                    {w.id === workspace?.id && <Check size={14} className='text-accent'/>}
                                </button>
                            ))}
                            <div className='my-1 h-px bg-line'/>
                            {([['invite', 'Invite people'], ['settings', 'Settings'], ['new-workspace', 'New workspace']] as const).map(([a, label]) => (
                                <button key={a} type='button' onClick={() => {
                                    setMenu(false);
                                    onAction(a);
                                }} className='flex w-full items-center rounded-xl px-2.5 py-2 text-left text-[13px] text-text hover:bg-tint'>{label}</button>
                            ))}
                        </div>
                    </>
                )}
            </div>
            <div className='flex gap-1.5 px-3 pb-2'>
                <label className='flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl bg-white/70 px-3 text-nav-muted ring-1 ring-nav-line focus-within:ring-accent dark:bg-white/5'>
                    <Search size={14}/>
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='Find a chat' className='min-w-0 flex-1 bg-transparent text-[13px] text-nav-text outline-none placeholder:text-nav-muted'/>
                </label>
                <button type='button' title='Search messages' aria-label='Search messages' onClick={() => onAction('search')} className='grid size-9 place-items-center rounded-xl bg-white/70 text-nav-muted ring-1 ring-nav-line hover:text-nav-text dark:bg-white/5'>
                    <TextSearch size={15}/>
                </button>
            </div>

            <nav className='scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3'>
                <button
                    type='button'
                    onClick={() => setActive(null)}
                    className={`mb-1 flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${active === null ? 'bg-[var(--active-chat)] ring-1 ring-nav-line' : 'hover:bg-white/60 dark:hover:bg-white/5'}`}
                    style={active === null ? {boxShadow: 'var(--shadow-control)'} : undefined}
                >
                    <span className='grid size-[26px] shrink-0 place-items-center rounded-lg bg-white text-accent-text ring-1 ring-line dark:bg-white/10'><LayoutDashboard size={15}/></span>
                    <span className={`min-w-0 flex-1 truncate text-[13.5px] ${active === null ? 'font-bold text-nav-text' : 'font-medium text-nav-muted'}`}>Home</span>
                </button>
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
                            const who = post ? displayName(users[post.userId]) : '';
                            const line = d ? d.title : item.kind === 'dm' ? plain(post?.message ?? '') || 'New message' : `${who} mentioned you`;
                            return (
                                <button
                                    key={`${item.channelId}:${item.postId}`}
                                    type='button'
                                    onClick={() => {
                                        setActive(item.channelId);
                                        if (post?.rootId) {
                                            useStore.getState().openThread(post.rootId);
                                        }
                                    }}
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

                {agentRows.length > 0 && (
                    <section className='mb-1'>
                        <h2 className='px-2.5 pt-3 pb-1 text-[11.5px] font-bold text-nav-muted'>Agents</h2>
                        {agentRows.map(({agent, chat}) => {
                            const isActive = chat?.channel.id === active;
                            const bold = (chat?.unread ?? 0) > 0;
                            return (
                                <button
                                    key={agent.id}
                                    type='button'
                                    onClick={() => void openAgent(agent, chat)}
                                    className={`mb-px flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${isActive ? 'bg-[var(--active-chat)] ring-1 ring-nav-line' : 'hover:bg-white/60 dark:hover:bg-white/5'}`}
                                    style={isActive ? {boxShadow: 'var(--shadow-control)'} : undefined}
                                    title={agent.description}
                                >
                                    <span className='grid size-[26px] shrink-0 place-items-center overflow-hidden rounded-lg bg-white ring-1 ring-line'>
                                        <img src={portraitSrc(agent.portrait, agent.handle)} alt='' className={agent.isCoordinator ? 'size-[72%]' : 'size-full'}/>
                                    </span>
                                    <span className={`min-w-0 flex-1 truncate text-[13.5px] ${bold || isActive ? 'font-bold text-nav-text' : 'font-medium text-nav-muted'}`}>{agent.name}</span>
                                    {bold && <span className='size-2 rounded-full bg-accent'/>}
                                </button>
                            );
                        })}
                    </section>
                )}

                <Section label='Channels' onAdd={() => onAction('new-channel')} addLabel='New channel' extra={<button type='button' onClick={() => onAction('browse')} className='text-[11px] font-semibold text-nav-muted hover:text-nav-text'>Browse</button>}>
                    {channelsList.map((c) => <ChatRow key={c.channel.id} chat={c} active={c.channel.id === active} onClick={() => setActive(c.channel.id)}/>)}
                </Section>
                <Section label='Direct messages' onAdd={() => onAction('new-dm')} addLabel='New message'>
                    {dms.map((c) => <ChatRow key={c.channel.id} chat={c} active={c.channel.id === active} onClick={() => setActive(c.channel.id)}/>)}
                    {dms.length === 0 && !q && <p className='px-2.5 py-1 text-[12px] text-nav-muted'>No messages yet.</p>}
                </Section>
                {error && <p className='px-2.5 text-[12px] text-alert'>{error}</p>}
            </nav>

            <div className='flex items-center gap-2.5 border-t border-nav-line px-3.5 py-3'>
                <span className='relative'>
                    <Avatar user={me ?? undefined} size={30}/>
                    <span title={connection} className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-[var(--rail-bg)] ${connection === 'online' ? 'bg-emerald-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-slate-400'}`}/>
                </span>
                <div className='min-w-0 flex-1'>
                    <div className='truncate text-[13px] font-bold text-nav-text'>{displayName(me ?? undefined)}</div>
                    <div className='flex items-center gap-1 truncate text-[11px] whitespace-nowrap text-nav-muted'>
                        {connection === 'offline' ? 'Reconnecting…' : connection === 'connecting' ? 'Connecting…' : isTauri ? <><Keyboard size={11}/> {keys.panel}: quick panel</> : 'Online'}
                    </div>
                </div>
                <button type='button' onClick={() => onAction('settings')} aria-label='Settings' title='Settings' className='grid size-8 place-items-center rounded-full text-nav-muted hover:bg-white/70 hover:text-nav-text dark:hover:bg-white/10'>
                    <Gear size={15}/>
                </button>
                <button type='button' onClick={onSignOut} aria-label='Sign out' title='Sign out' className='grid size-8 place-items-center rounded-full text-nav-muted hover:bg-white/70 hover:text-nav-text dark:hover:bg-white/10'>
                    <LogOut size={15}/>
                </button>
            </div>
        </aside>
    );
}

function Section({label, onAdd, addLabel, extra, children}: {label: string; onAdd: () => void; addLabel: string; extra?: React.ReactNode; children: React.ReactNode}) {
    return (
        <section className='mb-1'>
            <h2 className='group flex items-center gap-2 px-2.5 pt-3 pb-1 text-[11.5px] font-bold text-nav-muted'>
                <span className='flex-1'>{label}</span>
                {extra}
                <button type='button' onClick={onAdd} aria-label={addLabel} title={addLabel} className='grid size-5 place-items-center rounded-md hover:bg-white/70 hover:text-nav-text dark:hover:bg-white/10'><Plus size={13}/></button>
            </h2>
            {children}
        </section>
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
