import {AppWindow, ArrowLeft, Check, ChevronRight, Inbox, PenLine} from 'lucide-react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {ChatIcon} from '../components/ChatIcon';
import {ChatPicker} from '../components/ChatPicker';
import {Composer} from '../components/Composer';
import {plain} from '../components/Markup';
import {MessageRow} from '../components/MessageRow';
import {Typing} from '../components/Typing';
import {preloadRecent, resume} from '../lib/boot';
import {useChats} from '../lib/chats';
import {shortWhen} from '../lib/format';
import {hidePanel, onPanelTarget, openDashboard, type PanelTarget, setPanelHeight} from '../lib/native';
import {channelTitle, decisionOf, displayName, needsYou, type NeedsYouItem, useStore} from '../lib/store';
import type {Post} from '../lib/types';

export function Panel() {
    const [phase, setPhase] = useState<'loading' | 'signed-out' | 'ready'>('loading');
    const [target, setTarget] = useState<PanelTarget>({mode: 'compose'});
    const [opened, setOpened] = useState(0); // bumps on every show, to replay the entrance
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        resume().then((ok) => setPhase(ok ? 'ready' : 'signed-out'));
    }, []);

    useEffect(() => onPanelTarget((t) => {
        setTarget(t);
        setOpened((n) => n + 1);
        if (useStore.getState().ready) {
            void preloadRecent();
        }
    }), []);

    // Fit the window to the content.
    useEffect(() => {
        const el = box.current;
        if (!el) {
            return undefined;
        }
        const ro = new ResizeObserver(() => void setPanelHeight(el.getBoundingClientRect().height + 2));
        ro.observe(el);
        return () => ro.disconnect();
    }, [phase]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented) {
                void hidePanel();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <div className='p-px'>
            <div ref={box} key={opened} className='glass panel-in overflow-hidden rounded-[20px]'>
                {phase === 'loading' && <div className='grid h-40 place-items-center'><img src='/captain-mark.png' alt='' className='size-8 animate-pulse opacity-60'/></div>}
                {phase === 'signed-out' && <SignedOut/>}
                {phase === 'ready' && <Ready target={target} setTarget={setTarget}/>}
            </div>
        </div>
    );
}

function SignedOut() {
    return (
        <div className='flex flex-col items-center px-6 py-8 text-center'>
            <img src='/captain-mark.png' alt='' className='size-9'/>
            <p className='mt-3 text-[15px] font-bold text-ink'>Sign in to Captain</p>
            <p className='mt-1 text-[13px] text-muted'>Open the dashboard to sign in, then come back here.</p>
            <button type='button' onClick={() => void openDashboard()} className='mt-4 h-9 rounded-full bg-accent px-5 text-[13px] font-bold text-on-accent'>Open Captain</button>
        </div>
    );
}

function Ready({target, setTarget}: {target: PanelTarget; setTarget: (t: PanelTarget) => void}) {
    const channels = useStore((s) => s.channels);
    const members = useStore((s) => s.members);
    const posts = useStore((s) => s.posts);
    const postsByChannel = useStore((s) => s.postsByChannel);
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const waiting = useMemo(() => needsYou({channels, members, posts, postsByChannel, me, workspace}), [channels, members, posts, postsByChannel, me, workspace]);

    const tab = target.mode === 'thread' ? 'inbox' : target.mode;
    const tabBtn = (active: boolean) => `inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-bold transition-colors ${active ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink'}`;

    return (
        <>
            <div className='flex items-center gap-2 px-3 pt-3 pb-2'>
                <img src='/captain-mark.png' alt='' className='ml-1 size-5'/>
                <div className='flex items-center gap-0.5 rounded-full bg-tint/80 p-0.5'>
                    <button type='button' className={tabBtn(tab === 'compose')} onClick={() => setTarget({mode: 'compose'})}>
                        <PenLine size={13}/> Write
                    </button>
                    <button type='button' className={tabBtn(tab === 'inbox')} onClick={() => setTarget({mode: 'inbox'})}>
                        <Inbox size={13}/> Inbox
                        {waiting.length > 0 && <span className='min-w-4 rounded-full bg-gold px-1 text-center text-[10.5px] leading-4 text-white'>{waiting.length}</span>}
                    </button>
                </div>
                <button type='button' onClick={() => void openDashboard(target.channelId)} title='Open the dashboard' aria-label='Open the dashboard' className='ml-auto grid size-7 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'>
                    <AppWindow size={15}/>
                </button>
            </div>
            {target.mode === 'compose' && <ComposeView/>}
            {target.mode === 'inbox' && <InboxView items={waiting} onOpen={(i) => setTarget({mode: 'thread', channelId: i.channelId, postId: i.postId})}/>}
            {target.mode === 'thread' && target.channelId && <ThreadView channelId={target.channelId} postId={target.postId} onBack={() => setTarget({mode: 'inbox'})}/>}
            <div className='flex items-center justify-center gap-3 border-t border-line/60 px-3 py-1.5 text-[10.5px] font-medium text-muted'>
                <span>⏎ send</span><span>⇧⏎ new line</span><span>hold ⌥ to talk</span><span>esc close</span>
            </div>
        </>
    );
}

function ComposeView() {
    const lastUsed = useStore((s) => s.lastUsedChannelId);
    const channels = useStore((s) => s.channels);
    const chats = useChats();
    const [channelId, setChannelId] = useState<string | null>(() => (lastUsed && channels[lastUsed] ? lastUsed : null));
    const [sentTo, setSentTo] = useState<string | null>(null);
    const me = useStore((s) => s.me);
    const users = useStore((s) => s.users);

    useEffect(() => {
        if (!channelId && chats[0]) {
            setChannelId(chats[0].channel.id);
        }
    }, [channelId, chats]);

    const onSent = useCallback(() => {
        const title = channelTitle(channels[channelId ?? ''], me?.id, users);
        setSentTo(title);
        window.setTimeout(() => {
            setSentTo(null);
            void hidePanel();
        }, 900);
    }, [channelId, channels, me, users]);

    return (
        <div className='px-3 pb-3'>
            <Composer
                channelId={channelId}
                variant='panel'
                draftKey='panel'
                autoFocus
                placeholder='What should the team know? Talk, type or snap.'
                leading={<ChatPicker value={channelId} onChange={setChannelId}/>}
                onSent={onSent}
            />
            {sentTo && (
                <div className='mt-2 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold text-accent-text'>
                    <Check size={14} strokeWidth={3}/> Sent to {sentTo}
                </div>
            )}
        </div>
    );
}

function InboxView({items, onOpen}: {items: NeedsYouItem[]; onOpen: (i: NeedsYouItem) => void}) {
    const channels = useStore((s) => s.channels);
    const posts = useStore((s) => s.posts);
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me);
    const chats = useChats();
    const waitingIds = new Set(items.map((i) => i.channelId));
    const recent = chats.filter((c) => !waitingIds.has(c.channel.id)).slice(0, 4);

    return (
        <div className='scroll-quiet max-h-[440px] overflow-y-auto px-2 pb-2'>
            {items.length === 0 && (
                <div className='px-4 py-6 text-center'>
                    <div className='text-[22px]'>🌤️</div>
                    <p className='mt-1 text-[13.5px] font-bold text-ink'>Nothing needs you</p>
                    <p className='text-[12.5px] text-muted'>Mentions, DMs and decisions will show up here.</p>
                </div>
            )}
            {items.map((item) => {
                const channel = channels[item.channelId];
                const post: Post | undefined = item.postId ? posts[item.postId] : undefined;
                const d = decisionOf(post);
                const who = post ? displayName(users[post.userId]) : '';
                return (
                    <button
                        key={`${item.channelId}:${item.postId}`}
                        type='button'
                        onClick={() => onOpen(item)}
                        className='mb-1 flex w-full items-start gap-2.5 rounded-2xl bg-surface/80 p-2.5 text-left ring-1 ring-line transition-colors hover:bg-surface'
                    >
                        <ChatIcon channel={channel} size={32}/>
                        <span className='min-w-0 flex-1'>
                            <span className='flex items-baseline gap-2'>
                                <span className='truncate text-[13px] font-bold text-ink'>{channelTitle(channel, me?.id, users)}</span>
                                <span className='ml-auto shrink-0 text-[11px] text-muted'>{shortWhen(item.at)}</span>
                            </span>
                            {d ? (
                                <span className='mt-0.5 flex items-center gap-1.5 text-[12.5px] text-gold-text'>
                                    <span className='size-1.5 shrink-0 rounded-full bg-gold'/>
                                    <span className='truncate font-semibold'>Decision: {d.title}</span>
                                </span>
                            ) : (
                                <span className='mt-0.5 line-clamp-2 text-[12.5px] text-text'>
                                    {who && channel?.type !== 'D' && <span className='font-semibold'>{who}: </span>}
                                    {plain(post?.message ?? '') || 'New message'}
                                </span>
                            )}
                        </span>
                        <ChevronRight size={15} className='mt-2 shrink-0 text-muted'/>
                    </button>
                );
            })}
            {recent.length > 0 && (
                <>
                    <div className='px-2 pt-2 pb-1 text-[11px] font-bold text-muted'>Recent</div>
                    {recent.map((c) => (
                        <button key={c.channel.id} type='button' onClick={() => onOpen({channelId: c.channel.id, kind: 'mention', at: c.channel.lastPostAt})} className='flex h-9 w-full items-center gap-2.5 rounded-xl px-2 text-left hover:bg-surface/70'>
                            <ChatIcon channel={c.channel} size={22}/>
                            <span className='min-w-0 flex-1 truncate text-[13px] font-semibold text-ink'>{c.title}</span>
                            <span className='text-[11px] text-muted'>{shortWhen(c.channel.lastPostAt || c.channel.createdAt)}</span>
                        </button>
                    ))}
                </>
            )}
        </div>
    );
}

// The thread that needs you, with enough context to decide right here.
function ThreadView({channelId, postId, onBack}: {channelId: string; postId?: string; onBack: () => void}) {
    const channel = useStore((s) => s.channels[channelId]);
    const me = useStore((s) => s.me);
    const users = useStore((s) => s.users);
    const posts = useStore((s) => s.posts);
    const ids = useStore((s) => s.postsByChannel[channelId]);
    const loaded = useStore((s) => s.loadedChannels[channelId]);
    const loadPosts = useStore((s) => s.loadPosts);
    const markViewed = useStore((s) => s.markViewed);
    const scroller = useRef<HTMLDivElement>(null);
    const focus = postId ? posts[postId] : undefined;
    const rootId = focus ? focus.rootId || focus.id : '';
    const loadThread = useStore((s) => s.loadThread);

    useEffect(() => {
        if (!loaded) {
            void loadPosts(channelId).catch(() => undefined);
        }
        if (rootId) {
            void loadThread(rootId).catch(() => undefined);
        }
        void markViewed(channelId);
    }, [channelId, rootId, loaded, loadPosts, loadThread, markViewed]);

    const context = useMemo(() => {
        const all = (ids ?? []).map((id) => posts[id]).filter(Boolean);
        const inThread = rootId ? all.filter((p) => p.id === rootId || p.rootId === rootId) : [];
        // A thread with replies reads best on its own.
        if (inThread.length > 1) {
            return inThread.slice(-6);
        }
        // Otherwise end on the message that needs you, with a little lead-up.
        const top = all.filter((p) => !p.rootId);
        const at = postId ? top.findIndex((p) => p.id === postId) : -1;
        return at >= 0 ? top.slice(Math.max(0, at - 3), at + 1) : top.slice(-6);
    }, [ids, posts, rootId, postId]);

    useEffect(() => {
        const el = scroller.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [context.length, context.at(-1)?.message.length]);

    if (!channel) {
        return null;
    }
    const isChannel = channel.type === 'O' || channel.type === 'P';
    return (
        <div className='px-3 pb-3'>
            <div className='mb-1 flex items-center gap-2'>
                <button type='button' onClick={onBack} aria-label='Back to inbox' className='grid size-7 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'>
                    <ArrowLeft size={15}/>
                </button>
                <ChatIcon channel={channel} size={22}/>
                <span className='min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink'>{channelTitle(channel, me?.id, users)}</span>
                <button type='button' onClick={() => void openDashboard(channelId)} className='text-[12px] font-semibold text-accent-text hover:underline'>Open in dashboard</button>
            </div>
            <div ref={scroller} className='scroll-quiet max-h-[380px] overflow-y-auto rounded-2xl bg-surface/70 px-2.5 pb-3 ring-1 ring-line'>
                {!loaded && <div className='py-8 text-center text-[12.5px] text-muted'>Loading…</div>}
                {context.map((p) => <MessageRow key={p.id} post={p} compact/>)}
            </div>
            <Typing channelId={channelId}/>
            <Composer
                channelId={channelId}
                rootId={isChannel && rootId ? rootId : null}
                variant='panel'
                draftKey={`reply.${channelId}.${rootId}`}
                autoFocus
                placeholder={isChannel && rootId ? 'Reply in thread' : 'Reply'}
            />
        </div>
    );
}
