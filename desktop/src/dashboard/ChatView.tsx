import {AtSign, LogOut, UserPlus, X} from 'lucide-react';
import {Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

import {ChatIcon} from '../components/ChatIcon';
import {Composer} from '../components/Composer';
import {isGrouped, MessageRow} from '../components/MessageRow';
import {Typing} from '../components/Typing';
import {api, errorMessage} from '../lib/api';
import {dayLabel} from '../lib/format';
import {mentionsAgent} from '../lib/send';
import {agentForUser, channelTitle, displayName, isAgentChannel, otherUserId, useStore} from '../lib/store';
import type {ClientPost} from '../lib/types';

import {Overview} from './Overview';

export function ChatView({channelId, onInvite, onModels}: {channelId: string | null; onInvite: () => void; onModels: () => void}) {
    if (!channelId) {
        return <Overview onInvite={onInvite} onModels={onModels}/>;
    }
    return <Chat key={channelId} channelId={channelId} onModels={onModels}/>;
}

function scrollToPost(id: string) {
    const el = document.getElementById(`post-${id}`);
    if (el) {
        el.scrollIntoView({behavior: 'smooth', block: 'center'});
        el.classList.add('flash');
        window.setTimeout(() => el.classList.remove('flash'), 1400);
    }
}

function Chat({channelId, onModels}: {channelId: string; onModels: () => void}) {
    const channel = useStore((s) => s.channels[channelId]);
    const me = useStore((s) => s.me);
    const users = useStore((s) => s.users);
    const agents = useStore((s) => s.agents);
    const ids = useStore((s) => s.postsByChannel[channelId]);
    const posts = useStore((s) => s.posts);
    const loaded = useStore((s) => s.loadedChannels[channelId]);
    const hasMore = useStore((s) => s.hasMore[channelId]);
    const loadPosts = useStore((s) => s.loadPosts);
    const loadOlder = useStore((s) => s.loadOlder);
    const markViewed = useStore((s) => s.markViewed);
    const threadRootId = useStore((s) => s.threadRootId);
    const openThread = useStore((s) => s.openThread);
    const demoMode = useStore((s) => s.demoMode);
    const scroller = useRef<HTMLDivElement>(null);
    const nearBottom = useRef(true);
    const [lightbox, setLightbox] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!loaded) {
            loadPosts(channelId).catch((e) => setError(errorMessage(e)));
        }
    }, [channelId, loaded, loadPosts]);

    // In the main view, a thread shows as its first message; replies live in the thread pane.
    const list = useMemo(() => (ids ?? []).map((id) => posts[id]).filter((p): p is ClientPost => Boolean(p) && !p.rootId), [ids, posts]);
    const lastText = list.at(-1)?.message.length ?? 0;

    // Reading the chat marks it read, including messages that arrive while it's open.
    const count = ids?.length ?? 0;
    useEffect(() => {
        if (document.hasFocus()) {
            void markViewed(channelId);
        }
        const onFocus = () => void markViewed(channelId);
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [channelId, count, markViewed]);

    const streamLen = useStore((s) => {
        const last = list.at(-1);
        return last ? s.streams[last.id]?.length ?? 0 : 0;
    });
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && nearBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [list.length, loaded, lastText, streamLen]);

    if (!channel || !me) {
        return null;
    }
    const title = channelTitle(channel, me.id, users);
    const agentUser = isAgentChannel(channel, me.id, users) ? users[otherUserId(channel, me.id)] : undefined;
    const agent = agentForUser(agents, agentUser?.id);
    const subtitle = agent ? agent.description || 'Agent' : channel.purpose || (channel.type === 'D' ? 'Direct message' : channel.type === 'P' ? 'Private group chat' : 'Group chat');
    const isChannel = channel.type === 'O' || channel.type === 'P';
    const isGroup = channel.type !== 'D';

    return (
        <div className='flex min-h-0 min-w-0 flex-1'>
            <div className='flex min-w-0 flex-1 flex-col'>
                <header data-tauri-drag-region className='flex h-16 shrink-0 items-center gap-3 border-b border-line/70 px-6'>
                    <ChatIcon channel={channel} size={32}/>
                    <div className='min-w-0 flex-1'>
                        <h1 className='truncate text-[16px] font-extrabold tracking-tight text-ink'>{title}</h1>
                        <p className='truncate text-[12px] text-muted'>{subtitle}</p>
                    </div>
                    {isGroup && <JoinsIn channelId={channelId} on={channel.captainJoinsIn !== false}/>}
                    {isChannel && <ChannelMenu channelId={channelId} general={channel.name === 'general'}/>}
                </header>
                {demoMode && agent && (
                    <div className='flex items-center gap-3 border-b border-line/70 bg-gold-tint px-6 py-1.5 text-[12px] text-gold-text'>
                        <span className='min-w-0 flex-1'>Demo mode: agents give sample answers until someone who runs this server adds a model key.</span>
                        {me?.instanceAdmin && (
                            <button type='button' onClick={onModels} className='shrink-0 font-bold underline underline-offset-2'>Add a key</button>
                        )}
                    </div>
                )}
                <div
                    ref={scroller}
                    onScroll={(e) => {
                        const el = e.currentTarget;
                        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
                        if (el.scrollTop < 60 && hasMore && loaded) {
                            const h = el.scrollHeight;
                            void loadOlder(channelId).then(() => requestAnimationFrame(() => {
                                el.scrollTop = el.scrollHeight - h + el.scrollTop;
                            }));
                        }
                    }}
                    className='scroll-quiet min-h-0 flex-1 overflow-y-auto'
                >
                    <div className='mx-auto max-w-[780px] px-6 pt-4 pb-6'>
                        {error && <div className='py-6 text-center text-[13px] text-alert'>{error}</div>}
                        {!loaded && !error && <div className='py-16 text-center text-[13px] text-muted'>Loading messages…</div>}
                        {loaded && list.length === 0 && <Empty channelId={channelId} title={title} agentName={agent?.name} isCoordinator={agent?.isCoordinator}/>}
                        {list.map((post, i) => {
                            const prev = list[i - 1];
                            const newDay = !prev || dayLabel(prev.createdAt) !== dayLabel(post.createdAt);
                            return (
                                <Fragment key={post.id}>
                                    {newDay && (
                                        <div className='my-4 flex items-center gap-3 text-[11.5px] font-semibold text-muted'>
                                            <span className='h-px flex-1 bg-line'/>
                                            {dayLabel(post.createdAt)}
                                            <span className='h-px flex-1 bg-line'/>
                                        </div>
                                    )}
                                    <MessageRow
                                        post={post}
                                        grouped={!newDay && isGrouped(prev, post) && post.replyCount === 0 && (prev?.replyCount ?? 0) === 0}
                                        onOpenImage={setLightbox}
                                        onOpenThread={openThread}
                                        onOpenPost={(id) => {
                                            const p = posts[id];
                                            if (p?.rootId) {
                                                openThread(p.rootId);
                                                window.setTimeout(() => scrollToPost(id), 250);
                                            } else {
                                                scrollToPost(id);
                                            }
                                        }}
                                    />
                                </Fragment>
                            );
                        })}
                    </div>
                </div>
                <div className='shrink-0 px-6 pb-5'>
                    <div className='mx-auto max-w-[780px]'>
                        <Typing channelId={channelId}/>
                        <Composer
                            channelId={channelId}
                            variant='dashboard'
                            draftKey={channelId}
                            autoFocus
                            placeholder={agent ? `Message ${agent.name}` : isGroup ? `Message ${title} · @ to bring in an agent` : `Message ${title}`}
                            onSent={(post) => {
                                nearBottom.current = true;
                                // Calling on an agent in a channel: watch it work in the thread.
                                if (channel.type !== 'D' && !post.rootId && mentionsAgent(post.message)) {
                                    openThread(post.id);
                                }
                            }}
                        />
                    </div>
                </div>
            </div>
            {threadRootId && posts[threadRootId]?.channelId === channelId && <ThreadPane rootId={threadRootId} onClose={() => openThread(null)} onOpenImage={setLightbox}/>}
            {lightbox && (
                <button type='button' aria-label='Close image' onClick={() => setLightbox(null)} className='fixed inset-0 z-50 grid place-items-center bg-black/60 p-10 backdrop-blur-sm'>
                    <img src={lightbox} alt='' className='max-h-full max-w-full rounded-2xl shadow-2xl'/>
                </button>
            )}
        </div>
    );
}

function Empty({channelId, title, agentName, isCoordinator}: {channelId: string; title: string; agentName?: string; isCoordinator?: boolean}) {
    const channel = useStore((s) => s.channels[channelId]);
    return (
        <div className='py-16 text-center'>
            <div className='inline-block'><ChatIcon channel={channel} size={52}/></div>
            <p className='mt-3 text-[15px] font-bold text-ink'>{agentName ? `Say hi to ${agentName}` : `This is the start of ${title}`}</p>
            <p className='mx-auto mt-1 max-w-[380px] text-[13px] text-muted'>
                {isCoordinator ?
                    'Ask a question, or hand over something bigger. Captain plans it, brings in the right agents and models, and checks with you before anything leaves the workspace.' :
                    agentName ? 'Ask anything, attach a screenshot, or hold ⌥ to talk.' :
                    'Captain joins in when it can help. Type @ to bring in a specific agent; @captain plans bigger work with the whole team.'}
            </p>
        </div>
    );
}

// Whether Captain joins this group chat on its own when it can help.
function JoinsIn({channelId, on}: {channelId: string; on: boolean}) {
    const addChannel = useStore((s) => s.addChannel);
    const [busy, setBusy] = useState(false);
    const toggle = async () => {
        setBusy(true);
        try {
            addChannel(await api.updateChannel(channelId, {captainJoinsIn: !on}));
        } catch {
            // the button shows the saved state
        } finally {
            setBusy(false);
        }
    };
    return (
        <button
            type='button'
            onClick={() => void toggle()}
            disabled={busy}
            aria-pressed={on}
            title={on ? 'Captain joins in when it can help. Click to only answer when someone writes @captain.' : 'Captain only answers when someone writes @captain. Click to let it join in when it can help.'}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold ring-1 transition-colors disabled:opacity-60 ${on ? 'bg-tint text-accent-text ring-accent/30' : 'text-muted ring-line hover:bg-tint hover:text-ink'}`}
        >
            <img src='/captain-mark.png' alt='' className={`size-3.5 ${on ? '' : 'opacity-50 grayscale'}`}/>
            {on ? 'Captain joins in' : 'Captain: only when @'}
        </button>
    );
}

function ChannelMenu({channelId, general}: {channelId: string; general: boolean}) {
    const [open, setOpen] = useState(false);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me);
    const dropChannel = useStore((s) => s.dropChannel);
    const [members, setMembers] = useState<string[]>([]);
    useEffect(() => {
        if (adding) {
            api.channelMembers(channelId).then((m) => setMembers(m.map((x) => x.userId))).catch(() => undefined);
        }
    }, [adding, channelId]);
    const candidates = Object.values(users).filter((u) => u.id !== me?.id && !members.includes(u.id));
    return (
        <div className='relative'>
            <button type='button' onClick={() => setOpen((o) => !o)} className='inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold text-muted ring-1 ring-line hover:bg-tint hover:text-ink'>
                <UserPlus size={14}/> Members
            </button>
            {open && (
                <>
                    <div className='fixed inset-0 z-20' onClick={() => {
                        setOpen(false);
                        setAdding(false);
                    }}/>
                    <div className='absolute top-10 right-0 z-30 w-72 overflow-hidden rounded-2xl bg-glass-strong p-1.5 ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)', backdropFilter: 'blur(24px)'}}>
                        {!adding ? (
                            <>
                                <button type='button' onClick={() => setAdding(true)} className='flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-text hover:bg-tint'><AtSign size={14}/> Add people or agents</button>
                                {!general && (
                                    <button type='button' onClick={() => api.leaveChannel(channelId).then(() => dropChannel(channelId)).catch((e) => setError(errorMessage(e)))} className='flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-text hover:bg-tint'><LogOut size={14}/> Leave group chat</button>
                                )}
                            </>
                        ) : (
                            <div className='scroll-quiet max-h-72 overflow-y-auto'>
                                {candidates.map((u) => (
                                    <button key={u.id} type='button' onClick={() => api.addChannelMembers(channelId, [u.id]).then(() => setMembers((m) => [...m, u.id])).catch((e) => setError(errorMessage(e)))} className='flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] hover:bg-tint'>
                                        <span className='min-w-0 flex-1 truncate font-semibold text-ink'>{displayName(u)}</span>
                                        <span className='text-[11px] text-muted'>{u.isBot ? 'Agent' : 'Add'}</span>
                                    </button>
                                ))}
                                {candidates.length === 0 && <p className='px-2.5 py-3 text-[12.5px] text-muted'>Everyone is already here.</p>}
                            </div>
                        )}
                        {error && <p className='px-2.5 py-1 text-[12px] text-alert'>{error}</p>}
                    </div>
                </>
            )}
        </div>
    );
}

// A thread beside the chat: where agents post their plans, steps and results.
function ThreadPane({rootId, onClose, onOpenImage}: {rootId: string; onClose: () => void; onOpenImage: (url: string) => void}) {
    const root = useStore((s) => s.posts[rootId]);
    const ids = useStore((s) => (root ? s.postsByChannel[root.channelId] : undefined));
    const posts = useStore((s) => s.posts);
    const channel = useStore((s) => (root ? s.channels[root.channelId] : undefined));
    const scroller = useRef<HTMLDivElement>(null);
    const replies = useMemo(() => (ids ?? []).map((id) => posts[id]).filter((p): p is ClientPost => Boolean(p) && p.rootId === rootId), [ids, posts, rootId]);
    const streamLen = useStore((s) => {
        const last = replies.at(-1);
        return last ? s.streams[last.id]?.length ?? 0 : 0;
    });
    const nearBottom = useRef(true);
    const lastLen = replies.at(-1)?.message.length ?? 0;
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && nearBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [replies.length, streamLen, lastLen]);
    if (!root || !channel) {
        return null;
    }
    return (
        <aside className='flex w-[420px] shrink-0 flex-col border-l border-line/70 bg-bg'>
            <header data-tauri-drag-region className='flex h-16 shrink-0 items-center gap-2 border-b border-line/70 px-5'>
                <div className='min-w-0 flex-1'>
                    <h2 className='text-[15px] font-extrabold tracking-tight text-ink'>Thread</h2>
                    <p className='truncate text-[12px] text-muted'>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</p>
                </div>
                <button type='button' aria-label='Close thread' onClick={onClose} className='grid size-8 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'><X size={16}/></button>
            </header>
            <div ref={scroller} onScroll={(e) => {
                const el = e.currentTarget;
                nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
            }} className='scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-4'>
                <MessageRow post={root} inThread onOpenImage={onOpenImage}/>
                <div className='my-3 flex items-center gap-3 text-[11px] font-semibold text-muted'>
                    <span className='h-px flex-1 bg-line'/>{replies.length > 0 ? 'Replies' : 'No replies yet'}<span className='h-px flex-1 bg-line'/>
                </div>
                {replies.map((p, i) => (
                    <MessageRow key={p.id} post={p} inThread grouped={isGrouped(replies[i - 1], p)} onOpenImage={onOpenImage} onOpenPost={scrollToPost}/>
                ))}
            </div>
            <div className='shrink-0 px-5 pb-5'>
                <Typing channelId={channel.id}/>
                <Composer channelId={channel.id} rootId={rootId} variant='dashboard' draftKey={`thread.${rootId}`} placeholder='Reply in thread'/>
            </div>
        </aside>
    );
}
