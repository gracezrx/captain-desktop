import {emitTo} from '@tauri-apps/api/event';
import {AppWindow, ArrowLeft, Check, Inbox, Mic, PenLine} from 'lucide-react';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {Avatar, portraitSrc} from '../components/Avatar';
import {ChatIcon} from '../components/ChatIcon';
import {ChatPicker} from '../components/ChatPicker';
import {Composer, type Incoming} from '../components/Composer';
import {plain} from '../components/Markup';
import {MessageRow} from '../components/MessageRow';
import {Typing} from '../components/Typing';
import {api, errorMessage} from '../lib/api';
import {preloadRecent, resume} from '../lib/boot';
import {useChats} from '../lib/chats';
import {shortWhen} from '../lib/format';
import {hidePanel, isTauri, onPanelTarget, openDashboard, type PanelTarget, setPanelHeight} from '../lib/native';
import {agentForUser, channelTitle, decisionOf, displayName, needsYou, type NeedsYouItem, useStore} from '../lib/store';
import type {ReplyByVoice} from '../lib/talk';
import type {ActivityRun, Post} from '../lib/types';
import {Mascot} from '../orb/Mascot';

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

    // Fit the window to the content. The box is new on every open (to replay
    // the entrance), so watch the new one; and measure its layout height, not
    // its on-screen size, which the entrance animation scales down.
    useEffect(() => {
        const el = box.current;
        if (!el) {
            return undefined;
        }
        const fit = () => void setPanelHeight(el.offsetHeight + 2);
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        fit();
        return () => ro.disconnect();
    }, [phase, opened]);

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

// What the Chrome extension adds around the same panel.
export type PanelExtras = {
    tools?: ReactNode; // above the composer when writing
    incoming?: Incoming | null; // handed to the composer
    header?: ReactNode; // next to the "open dashboard" button
    hints?: string[]; // the keyboard hints along the bottom
    keepOpenAfterSend?: boolean;
    openThreadAfterSend?: boolean; // show the conversation, so replies appear right there
    tall?: boolean; // more room for the conversation (Chrome's side panel)
};

const MAC_HINTS = ['⏎ send', 'hold ⌃⇧Space to talk', 'esc folds it back'];

export function Ready({target, setTarget, extras = {}}: {target: PanelTarget; setTarget: (t: PanelTarget) => void; extras?: PanelExtras}) {
    const channels = useStore((s) => s.channels);
    const members = useStore((s) => s.members);
    const posts = useStore((s) => s.posts);
    const postsByChannel = useStore((s) => s.postsByChannel);
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const waiting = useMemo(() => needsYou({channels, members, posts, postsByChannel, me, workspace}), [channels, members, posts, postsByChannel, me, workspace]);

    const working = useWorking();
    const tab = target.mode === 'thread' ? 'inbox' : target.mode;
    const tabBtn = (active: boolean) => `inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-bold transition-colors ${active ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink'}`;
    const busyCount = working?.length ?? 0;
    const status = [waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} you` : '', busyCount ? `${busyCount} working` : ''].filter(Boolean).join(' · ') || 'All clear';

    return (
        <>
            <div className='flex items-center gap-2.5 px-3 pt-2.5 pb-2'>
                <Mascot state={busyCount ? 'working' : waiting.length ? 'needs' : 'idle'} size={34}/>
                <div className='flex min-w-0 flex-1 flex-col'>
                    <span className='text-[15px] leading-tight font-extrabold text-ink'>Captain</span>
                    <span className='truncate text-[12px] font-semibold text-muted'>{status}</span>
                </div>
                <div className='flex items-center gap-0.5 rounded-full bg-tint/80 p-0.5'>
                    <button type='button' className={tabBtn(tab === 'compose')} onClick={() => setTarget({mode: 'compose'})} title='Write to a chat' aria-label='Write to a chat' aria-pressed={tab === 'compose'}>
                        <PenLine size={14}/>
                    </button>
                    <button type='button' className={tabBtn(tab === 'inbox')} onClick={() => setTarget({mode: 'inbox'})} title='What needs you, and what is being worked on' aria-label='What needs you' aria-pressed={tab === 'inbox'}>
                        <Inbox size={14}/>
                        {waiting.length > 0 && <span className='min-w-4 rounded-full bg-gold px-1 text-center text-[10.5px] leading-4 text-white'>{waiting.length}</span>}
                    </button>
                </div>
                <span className='flex items-center gap-0.5'>
                    {extras.header}
                    <button type='button' onClick={() => void openDashboard(target.channelId)} title='Open the dashboard' aria-label='Open the dashboard' className='grid size-7 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'>
                        <AppWindow size={15}/>
                    </button>
                </span>
            </div>
            {target.mode === 'compose' && (
                <ComposeView
                    tools={extras.tools}
                    incoming={extras.incoming}
                    keepOpen={extras.keepOpenAfterSend}
                    onSentTo={extras.openThreadAfterSend ? (post) => setTarget({mode: 'thread', channelId: post.channelId, postId: post.id}) : undefined}
                />
            )}
            {target.mode === 'inbox' && <InboxView items={waiting} working={working} onWrite={() => setTarget({mode: 'compose'})} onOpen={(i) => setTarget({mode: 'thread', channelId: i.channelId, postId: i.postId})}/>}
            {target.mode === 'thread' && target.channelId && <ThreadView channelId={target.channelId} postId={target.postId} tall={extras.tall} onBack={() => setTarget({mode: 'inbox'})}/>}
            <div className='flex items-center justify-center gap-3 border-t border-line/60 px-3 py-1.5 text-[10.5px] font-medium text-muted'>
                {(extras.hints ?? MAC_HINTS).map((h) => <span key={h}>{h}</span>)}
            </div>
        </>
    );
}

function ComposeView({tools, incoming, keepOpen, onSentTo}: {tools?: ReactNode; incoming?: Incoming | null; keepOpen?: boolean; onSentTo?: (post: Post) => void}) {
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

    const onSent = useCallback((post: Post) => {
        if (onSentTo) {
            onSentTo(post);
            return;
        }
        const title = channelTitle(channels[channelId ?? ''], me?.id, users);
        setSentTo(title);
        window.setTimeout(() => {
            setSentTo(null);
            if (!keepOpen) {
                void hidePanel();
            }
        }, 900);
    }, [channelId, channels, me, users, keepOpen, onSentTo]);

    return (
        <div className='px-3 pb-3'>
            {tools}
            <Composer
                channelId={channelId}
                variant='panel'
                draftKey='panel'
                autoFocus
                placeholder='What should the team know? Talk, type or snap.'
                leading={<ChatPicker value={channelId} onChange={setChannelId}/>}
                onSent={onSent}
                incoming={incoming}
            />
            {sentTo && (
                <div className='mt-2 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold text-accent-text'>
                    <Check size={14} strokeWidth={3}/> Sent to {sentTo}
                </div>
            )}
        </div>
    );
}

// The card at the top right (the floating Captain's click, the menu bar
// icon): what needs you, with the decision right there, and what the agents
// are working on, from the "Captain Lite — floating Captain" canvas.
function useWorking(): ActivityRun[] | null {
    const workspace = useStore((s) => s.workspace);
    const runs = useStore((s) => s.runs);
    const [active, setActive] = useState<ActivityRun[] | null>(null);
    useEffect(() => {
        if (!workspace) {
            return undefined;
        }
        let gone = false;
        const t = window.setTimeout(() => {
            // A task waiting for a decision is already under "Needs you".
            void api.dashboard(workspace.id).then((d) => !gone && setActive(d.active.filter((r) => r.status !== 'waiting_approval'))).catch(() => undefined);
        }, 250);
        return () => {
            gone = true;
            window.clearTimeout(t);
        };
    }, [workspace, runs]);
    return active;
}

function Section({tone, children}: {tone: 'gold' | 'blue'; children: ReactNode}) {
    return (
        <div className={`flex items-center gap-1.5 px-1.5 pt-1 text-[12px] font-extrabold ${tone === 'gold' ? 'text-gold-text' : 'text-accent-text'}`}>
            <span className={`size-[7px] rounded-full ${tone === 'gold' ? 'bg-gold' : 'bg-accent'}`}/>
            {children}
        </div>
    );
}

const article = 'flex flex-col gap-2 rounded-2xl bg-surface/90 p-3 ring-1 ring-line';
const pillBtn = 'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold disabled:opacity-60';

function InboxView({items, working, onOpen, onWrite}: {items: NeedsYouItem[]; working: ActivityRun[] | null; onOpen: (i: NeedsYouItem) => void; onWrite: () => void}) {
    const channels = useStore((s) => s.channels);
    const posts = useStore((s) => s.posts);
    const users = useStore((s) => s.users);
    const agents = useStore((s) => s.agents);
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const updatePost = useStore((s) => s.updatePost);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const where = (channelId: string) => {
        const c = channels[channelId];
        return !c ? '' : c.type === 'D' ? 'in your messages' : c.type === 'G' ? 'in a group message' : `in # ${channelTitle(c, me?.id, users)}`;
    };
    const approve = async (post: Post) => {
        setBusy(post.id);
        setError(null);
        try {
            updatePost(await api.postAction(post.id, 'approve'));
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const stop = async (run: ActivityRun) => {
        setBusy(run.id);
        try {
            await api.cancelRun(run.id);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const admin = workspace?.role === 'owner' || workspace?.role === 'admin';

    return (
        <div className='flex flex-col'>
            <div className='scroll-quiet flex max-h-[470px] flex-col gap-2 overflow-y-auto px-2.5 pb-2.5'>
                {items.length === 0 && (working?.length ?? 0) === 0 && (
                    <div className='flex flex-col items-center px-4 pt-2 pb-4 text-center'>
                        <Mascot state='idle' size={64}/>
                        <p className='mt-1 text-[13.5px] font-bold text-ink'>Nothing needs you</p>
                        <p className='text-[12.5px] text-muted'>Decisions, mentions and messages show up here, and what the agents are working on.</p>
                    </div>
                )}
                {items.length > 0 && <Section tone='gold'>Needs you</Section>}
                {items.slice(0, 6).map((item) => {
                    const post: Post | undefined = item.postId ? posts[item.postId] : undefined;
                    const d = decisionOf(post);
                    const author = post ? users[post.userId] : undefined;
                    const agent = post ? agentForUser(agents, post.userId) : undefined;
                    const key = `${item.channelId}:${item.postId}`;
                    return (
                        <article key={key} className={article}>
                            <div className='flex items-center gap-2.5'>
                                {agent ? <img src={portraitSrc(agent.portrait, agent.handle)} alt='' className='size-7 rounded-full bg-white ring-1 ring-line'/> : author ? <Avatar user={author} size={28}/> : <ChatIcon channel={channels[item.channelId]} size={28}/>}
                                <span className='min-w-0 flex-1 truncate text-[13px] text-muted'>
                                    <span className='font-extrabold text-ink'>{author ? displayName(author) : channelTitle(channels[item.channelId], me?.id, users)}</span> {where(item.channelId)}
                                </span>
                                <span className='shrink-0 text-[12px] text-muted'>{shortWhen(item.at)}</span>
                            </div>
                            {d ? (
                                <>
                                    <div className='flex flex-col gap-0.5'>
                                        <span className='text-[14.5px] leading-snug font-extrabold text-ink'>{d.title}</span>
                                        {(d.reason || d.fields[0]) && <span className='line-clamp-2 text-[12.5px] leading-snug text-muted'>{d.reason || `${d.fields[0].label}: ${d.fields[0].value}`}</span>}
                                    </div>
                                    <div className='flex items-center gap-2'>
                                        <button type='button' disabled={busy === post!.id} onClick={() => void approve(post!)} className={`${pillBtn} bg-accent text-on-accent`} style={{boxShadow: 'var(--shadow-send)'}}>
                                            <Check size={14} strokeWidth={2.6}/> {busy === post!.id ? 'Approving…' : 'Approve'}
                                        </button>
                                        <button type='button' onClick={() => onOpen(item)} className={`${pillBtn} bg-surface text-ink ring-1 ring-line hover:bg-tint`}>Read it first</button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <p className='line-clamp-3 text-[13.5px] leading-snug font-semibold text-text'>{plain(post?.message ?? '') || 'New message'}</p>
                                    <div className='flex items-center gap-1'>
                                        {isTauri && (
                                            <button type='button' onClick={() => {
                                                const c = channels[item.channelId];
                                                const name = channelTitle(c, me?.id, users);
                                                void emitTo('orb', 'orb-reply', {channelId: item.channelId, rootId: c?.type === 'D' || c?.type === 'G' ? post?.rootId ?? null : post?.rootId || post?.id || null, where: c?.type === 'D' || c?.type === 'G' ? name : `# ${name}`} satisfies ReplyByVoice);
                                                void hidePanel();
                                            }} className={`${pillBtn} h-8 bg-surface px-3.5 text-ink ring-1 ring-line hover:bg-tint`}>
                                                <Mic size={14}/> Reply by voice
                                            </button>
                                        )}
                                        <button type='button' onClick={() => onOpen(item)} className={`${pillBtn} h-8 px-3 text-accent-text hover:bg-tint`}>Open thread</button>
                                    </div>
                                </>
                            )}
                        </article>
                    );
                })}
                {items.length > 6 && <button type='button' onClick={() => void openDashboard()} className='px-2 text-left text-[12.5px] font-semibold text-accent-text hover:underline'>{items.length - 6} more in the dashboard</button>}

                {working && working.length > 0 && <Section tone='blue'>Working</Section>}
                {working?.slice(0, 4).map((run) => {
                    const faces = [...new Set(run.team?.length ? run.team : run.steps.length ? run.steps.map((st) => st.agentId) : [run.agentId])].map((id) => agents[id]).filter(Boolean).slice(0, 3);
                    const done = run.steps.filter((st) => st.status === 'succeeded').length;
                    const current = run.steps.find((st) => st.status === 'running');
                    const at = run.steps.length ? Math.min(run.steps.length, done + 1) : 0;
                    const lead = agents[run.agentId];
                    const line = run.status === 'waiting_approval' ? 'Waiting for a decision' : run.status === 'planning' || run.status === 'queued' ? 'Planning' :
                        current ? `Step ${at} of ${run.steps.length} · ${agents[current.agentId]?.name ?? 'Agent'}: ${current.title}` : `${lead?.name ?? 'Captain'} is writing`;
                    const canStop = admin || run.requestedBy === me?.id;
                    return (
                        <article key={run.id} className={article}>
                            <button type='button' onClick={() => onOpen({channelId: run.channelId, postId: run.rootPostId ?? run.triggerPostId ?? undefined, kind: 'mention', at: run.createdAt})} className='flex items-center gap-2.5 text-left'>
                                <span className='relative h-7 shrink-0' style={{width: 28 + (faces.length - 1) * 14}}>
                                    {faces.map((a, i) => <img key={a.id} src={portraitSrc(a.portrait, a.handle)} alt='' className='absolute top-0 size-7 rounded-full bg-white' style={{left: i * 14, boxShadow: i ? '0 0 0 2px #fff' : '0 0 0 1px rgba(20,39,105,0.08)'}}/>)}
                                </span>
                                <span className='flex min-w-0 flex-1 flex-col'>
                                    <span className='truncate text-[14px] leading-snug font-extrabold text-ink'>{run.goal || 'A reply'}</span>
                                    <span className='truncate text-[12.5px] text-muted'>
                                        {run.team?.length ? `Captain is coordinating ${run.team.map((id) => `@${agents[id]?.handle ?? 'agent'}`).join(' and ')}` : where(run.channelId).replace(/^in /, 'In ')}
                                    </span>
                                </span>
                            </button>
                            {run.steps.length > 0 && (
                                <div className='h-1 overflow-hidden rounded-full bg-tint'>
                                    <div className='h-full rounded-full bg-accent transition-all duration-500' style={{width: `${Math.max(6, (done / run.steps.length) * 100)}%`}}/>
                                </div>
                            )}
                            <div className='flex items-center justify-between gap-2 text-[12.5px] font-bold text-muted'>
                                <span className='flex min-w-0 items-center gap-1.5'>
                                    <span className='truncate'>{line}</span>
                                    <span className='flex shrink-0 gap-[3px]' aria-hidden>
                                        {[0, 200, 400].map((delay) => <span key={delay} className='size-1 animate-pulse rounded-full bg-accent' style={{animationDelay: `${delay}ms`}}/>)}
                                    </span>
                                </span>
                                {canStop && <button type='button' disabled={busy === run.id} onClick={() => void stop(run)} className='h-7 shrink-0 rounded-full px-2.5 hover:bg-tint hover:text-ink'>{busy === run.id ? 'Stopping…' : 'Stop'}</button>}
                            </div>
                        </article>
                    );
                })}
                {error && <p className='px-1.5 text-[12px] text-alert'>{error}</p>}
            </div>
            <div className='mx-2.5 mb-2 flex h-12 items-center gap-2 rounded-2xl bg-surface/90 pr-1.5 pl-4 ring-1 ring-line'>
                <button type='button' onClick={onWrite} className='min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-muted'>Ask Captain, or @ a chat</button>
                {isTauri && (
                    <button type='button' aria-label='Talk to Captain' title='Talk to Captain' onClick={() => {
                        void emitTo('orb', 'orb-talk', {});
                        void hidePanel();
                    }} className='grid size-[38px] place-items-center rounded-full bg-accent text-on-accent' style={{boxShadow: 'var(--shadow-send)'}}>
                        <Mic size={17}/>
                    </button>
                )}
            </div>
        </div>
    );
}

// The thread that needs you, with enough context to decide right here.
function ThreadView({channelId, postId, onBack, tall}: {channelId: string; postId?: string; onBack: () => void; tall?: boolean}) {
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
            <div ref={scroller} className={`scroll-quiet ${tall ? 'max-h-[calc(100vh-240px)] min-h-48' : 'max-h-[380px]'} overflow-y-auto rounded-2xl bg-surface/70 px-2.5 pb-3 ring-1 ring-line`}>
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
