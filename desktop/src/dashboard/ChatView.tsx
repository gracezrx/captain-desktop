import {Command, MousePointerClick, Sparkles} from 'lucide-react';
import {Fragment, useEffect, useLayoutEffect, useRef, useState} from 'react';

import {ChatIcon} from '../components/ChatIcon';
import {Composer} from '../components/Composer';
import {isGrouped, MessageRow} from '../components/MessageRow';
import {Typing} from '../components/Typing';
import {authedObjectUrl} from '../lib/mm';
import {dayLabel} from '../lib/format';
import {channelTitle, displayName, isAgentChannel, otherUserId, useStore} from '../lib/store';

export function ChatView({channelId}: {channelId: string | null}) {
    if (!channelId) {
        return <Home/>;
    }
    return <Chat key={channelId} channelId={channelId}/>;
}

function Chat({channelId}: {channelId: string}) {
    const channel = useStore((s) => s.channels[channelId]);
    const me = useStore((s) => s.me);
    const users = useStore((s) => s.users);
    const ids = useStore((s) => s.postsByChannel[channelId]);
    const posts = useStore((s) => s.posts);
    const loaded = useStore((s) => s.loadedChannels[channelId]);
    const loadPosts = useStore((s) => s.loadPosts);
    const markViewed = useStore((s) => s.markViewed);
    const scroller = useRef<HTMLDivElement>(null);
    const nearBottom = useRef(true);
    const [lightbox, setLightbox] = useState<string | null>(null);

    useEffect(() => {
        if (!loaded) {
            void loadPosts(channelId);
        }
    }, [channelId, loaded, loadPosts]);

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

    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && nearBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [count, loaded]);

    if (!channel || !me) {
        return null;
    }
    const title = channelTitle(channel, me.id, users);
    const agent = isAgentChannel(channel, me.id, users) ? users[otherUserId(channel, me.id)] : undefined;
    const subtitle = agent ? (agent as {bot_description?: string}).bot_description || 'Agent' : channel.purpose || (channel.type === 'D' ? 'Direct message' : channel.type === 'P' ? 'Private channel' : 'Channel');
    const list = (ids ?? []).map((id) => posts[id]).filter(Boolean);

    return (
        <>
            <header data-tauri-drag-region className='flex h-16 shrink-0 items-center gap-3 border-b border-line/70 px-6 backdrop-blur'>
                <ChatIcon channel={channel} size={32}/>
                <div className='min-w-0'>
                    <h1 className='truncate text-[16px] font-extrabold tracking-tight text-ink'>{title}</h1>
                    <p className='truncate text-[12px] text-muted'>{subtitle}</p>
                </div>
            </header>
            <div
                ref={scroller}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                }}
                className='scroll-quiet min-h-0 flex-1 overflow-y-auto'
            >
                <div className='mx-auto max-w-[780px] px-6 pt-4 pb-6'>
                    {!loaded && <div className='py-16 text-center text-[13px] text-muted'>Loading messages…</div>}
                    {loaded && list.length === 0 && (
                        <div className='py-16 text-center'>
                            <ChatIcon channel={channel} size={48}/>
                            <p className='mt-3 text-[14px] font-semibold text-ink'>This is the start of {title}</p>
                            <p className='text-[13px] text-muted'>{agent ? `Ask ${displayName(agent)} anything, or send a snapshot.` : 'Say hi.'}</p>
                        </div>
                    )}
                    {list.map((post, i) => {
                        const prev = list[i - 1];
                        const newDay = !prev || dayLabel(prev.create_at) !== dayLabel(post.create_at);
                        return (
                            <Fragment key={post.id}>
                                {newDay && (
                                    <div className='my-4 flex items-center gap-3 text-[11.5px] font-semibold text-muted'>
                                        <span className='h-px flex-1 bg-line'/>
                                        {dayLabel(post.create_at)}
                                        <span className='h-px flex-1 bg-line'/>
                                    </div>
                                )}
                                <MessageRow
                                    post={post}
                                    grouped={!newDay && isGrouped(prev, post)}
                                    onOpenImage={(url) => authedObjectUrl(url).then(setLightbox)}
                                />
                            </Fragment>
                        );
                    })}
                </div>
            </div>
            <div className='shrink-0 px-6 pb-5'>
                <div className='mx-auto max-w-[780px]'>
                    <Typing channelId={channelId}/>
                    <Composer channelId={channelId} variant='dashboard' draftKey={channelId} autoFocus placeholder={`Message ${title}`}/>
                </div>
            </div>
            {lightbox && (
                <button type='button' aria-label='Close image' onClick={() => setLightbox(null)} className='fixed inset-0 z-50 grid place-items-center bg-black/60 p-10 backdrop-blur-sm'>
                    <img src={lightbox} alt='' className='max-h-full max-w-full rounded-2xl shadow-2xl'/>
                </button>
            )}
        </>
    );
}

function Home() {
    const me = useStore((s) => s.me);
    return (
        <div data-tauri-drag-region className='grid flex-1 place-items-center px-8'>
            <div className='max-w-[460px] text-center'>
                <h1 className='text-[32px] font-extrabold tracking-tight text-ink'>Hi {me?.first_name || me?.username}</h1>
                <p className='mt-2 text-[15px] text-muted'>Pick a chat on the left, or reach Captain from anywhere on your Mac.</p>
                <div className='mt-8 grid gap-2.5 text-left'>
                    <Tip icon={<Command size={16}/>} title='⌥⇧Space opens the quick panel' text='Write to any chat without leaving what you are doing.'/>
                    <Tip icon={<Sparkles size={16}/>} title='Snapshot, then talk' text='The camera button grabs your screen; hold ⌥ or the mic to talk.'/>
                    <Tip icon={<MousePointerClick size={16}/>} title='Decide from the menu bar' text='When an agent needs a yes, click the banner and approve in place.'/>
                </div>
            </div>
        </div>
    );
}

function Tip({icon, title, text}: {icon: React.ReactNode; title: string; text: string}) {
    return (
        <div className='flex items-start gap-3 rounded-2xl bg-surface p-3.5 ring-1 ring-line' style={{boxShadow: 'var(--shadow-control)'}}>
            <span className='grid size-8 shrink-0 place-items-center rounded-xl bg-tint text-accent-text'>{icon}</span>
            <span>
                <span className='block text-[13.5px] font-bold text-ink'>{title}</span>
                <span className='block text-[12.5px] text-muted'>{text}</span>
            </span>
        </div>
    );
}
