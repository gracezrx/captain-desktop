import {MessageSquareReply, SmilePlus, Trash2} from 'lucide-react';
import {useEffect, useMemo, useRef, useState} from 'react';

import {api, errorMessage} from '../lib/api';
import {timeOfDay} from '../lib/format';
import {agentForUser, displayName, modelLabel, useStore} from '../lib/store';
import type {ClientPost, Post} from '../lib/types';

import {Avatar} from './Avatar';
import {Crew, CREW_MORE, CREW_QUICK, crewId, type CrewId, crewName, ReactionGlyph} from './Crew';
import {DecisionCard} from './DecisionCard';
import {Files} from './Files';
import {Markup} from './Markup';
import {PlanCard} from './PlanCard';
import {Dots} from './Typing';

type Props = {
    post: ClientPost;
    grouped?: boolean; // same author a moment ago: hide avatar and name
    compact?: boolean; // the menu bar panel
    inThread?: boolean; // shown inside a thread view (no thread summary)
    onOpenImage?: (url: string) => void;
    onOpenThread?: (rootId: string) => void;
    onOpenPost?: (postId: string) => void;
};

export function MessageRow({post, grouped = false, compact = false, inThread = false, onOpenImage, onOpenThread, onOpenPost}: Props) {
    const user = useStore((s) => s.users[post.userId]);
    const me = useStore((s) => s.me);
    const models = useStore((s) => s.models);
    const agents = useStore((s) => s.agents);
    const stream = useStore((s) => s.streams[post.id]);
    const workspace = useStore((s) => s.workspace);
    const [picker, setPicker] = useState(false);
    const [popped, setPopped] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const mine = post.userId === me?.id;
    const isAgent = Boolean(user?.isBot);
    const agent = isAgent ? agentForUser(agents, post.userId) : undefined;
    const streaming = Boolean(post.props.streaming);
    const text = streaming ? stream ?? '' : post.message;
    const size = compact ? 26 : 34;
    const step = post.props.step;
    const model = post.props.model;
    const canDelete = !post.pending && (mine || workspace?.role === 'owner' || workspace?.role === 'admin');

    const reactions = useMemo(() => groupReactions(post.reactions), [post.reactions]);
    const toggle = async (id: CrewId) => {
        setPicker(false);
        const had = reactions.find((r) => r.key === id)?.userIds.includes(me?.id ?? '');
        if (!had) {
            setPopped(id);
            setTimeout(() => setPopped((p) => (p === id ? null : p)), 700);
        }
        try {
            await (had ? api.unreact(post.id, id) : api.react(post.id, id));
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    return (
        <div id={`post-${post.id}`} className={`group relative flex gap-2.5 rounded-xl ${grouped ? 'mt-0.5' : compact ? 'mt-3' : 'mt-4'}`}>
            <div style={{width: size}} className='shrink-0 pt-0.5'>
                {!grouped && <Avatar user={user} size={size}/>}
            </div>
            <div className='min-w-0 flex-1'>
                {!grouped && (
                    <div className='flex items-baseline gap-2'>
                        <span className={`font-bold text-ink ${compact ? 'text-[12.5px]' : 'text-[13.5px]'}`}>{displayName(user)}</span>
                        {isAgent && <span className='rounded-full bg-tint px-1.5 py-px text-[10px] font-bold tracking-wide text-accent-text uppercase'>agent</span>}
                        {isAgent && post.props.joinedIn && <span className='text-[11px] font-semibold text-muted' title='Nobody asked; Captain joined in because it could help. Turn this off for a group chat with the switch at the top.'>joined in</span>}
                        <span className='text-[11px] text-muted'>{timeOfDay(post.createdAt)}</span>
                        {post.editedAt && <span className='text-[11px] text-muted'>(edited)</span>}
                    </div>
                )}
                {step && <div className='mt-0.5 text-[11.5px] font-semibold text-muted'>Step · {step.title}</div>}

                {post.type === 'plan' ? (
                    <PlanCard post={post} compact={compact} onOpenStep={onOpenPost}/>
                ) : post.type === 'decision' ? (
                    <DecisionCard post={post} compact={compact}/>
                ) : streaming && !text ? (
                    <div className='mt-1 inline-flex items-center gap-2 rounded-2xl rounded-tl-md bg-msg-agent px-3 py-2.5 text-[12.5px] text-muted'>
                        <Dots/> {agent ? `${agent.name} is working` : 'Working'}
                    </div>
                ) : text ? (
                    <div
                        className={`mt-1 inline-block max-w-full rounded-2xl rounded-tl-md px-3 py-2 leading-relaxed break-words ${compact ? 'text-[13px]' : 'text-[14px]'} ${post.props.error ? 'bg-alert/10 text-text ring-1 ring-alert/20' : mine ? 'bg-msg-human text-text' : isAgent ? 'bg-msg-agent text-text' : 'bg-bg-subtle text-text'} ${post.pending ? 'opacity-60' : ''}`}
                    >
                        {streaming && /^_.*…_$/.test(text) ? (
                            <span className='inline-flex items-center gap-2 text-muted'><Dots/> {text.slice(1, -2)}</span>
                        ) : (
                            <Markup text={text} meUsername={me?.username}/>
                        )}
                        {streaming && !/^_.*…_$/.test(text) && <span className='caret ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-accent'/>}
                    </div>
                ) : null}

                {post.failed && <div className='mt-1 text-[12px] text-alert'>Not sent. Check your connection and try again.</div>}
                {error && <div className='mt-1 text-[12px] text-alert'>{error}</div>}
                <Files files={post.files} compact={compact} onOpenImage={onOpenImage}/>

                {reactions.length > 0 && (
                    <div className='mt-1 flex flex-wrap gap-1'>
                        {reactions.map((r) => <ReactionPill key={r.key} reaction={r} meId={me?.id} pop={popped === r.key} onToggle={(id) => void toggle(id)}/>)}
                    </div>
                )}

                {isAgent && model && !streaming && !compact && post.type !== 'decision' && (
                    <div className='mt-1 text-[10.5px] text-muted opacity-0 transition-opacity group-hover:opacity-100' title={`${model.provider} · ${model.tier} tier · $${model.costUsd.toFixed(4)}`}>
                        via {modelLabel(models, model.id)} · {model.tier}
                    </div>
                )}

                {!inThread && !post.rootId && post.replyCount > 0 && onOpenThread && (
                    <ThreadSummary post={post} onOpen={() => onOpenThread(post.id)}/>
                )}
                <Planning post={post}/>
            </div>

            {!compact && !post.pending && (
                <div className={`absolute -top-3 right-1 items-center gap-0.5 rounded-full bg-surface p-0.5 ring-1 ring-line group-hover:flex ${picker ? 'flex' : 'hidden'}`} style={{boxShadow: 'var(--shadow-control)'}}>
                    {CREW_QUICK.map((id) => (
                        <button key={id} type='button' aria-label={crewName(id)} title={crewName(id)} onClick={() => void toggle(id)} className='grid size-7 place-items-center rounded-full transition-transform hover:scale-110 hover:bg-tint'>
                            <Crew id={id} size={20}/>
                        </button>
                    ))}
                    <span className='mx-0.5 h-4 w-px bg-line'/>
                    <button type='button' aria-label='More reactions' title='More reactions' aria-expanded={picker} onClick={() => setPicker((p) => !p)} className='grid size-7 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'><SmilePlus size={15}/></button>
                    {picker && <Picker onPick={(id) => void toggle(id)} onClose={() => setPicker(false)}/>}
                    {onOpenThread && !inThread && (
                        <button type='button' aria-label='Reply in thread' title='Reply in thread' onClick={() => onOpenThread(post.rootId ?? post.id)} className='grid size-7 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'><MessageSquareReply size={15}/></button>
                    )}
                    {canDelete && (
                        <button
                            type='button'
                            aria-label='Delete message'
                            title='Delete message'
                            onClick={() => {
                                if (confirm('Delete this message?')) {
                                    api.deletePost(post.id).catch((e) => setError(errorMessage(e)));
                                }
                            }}
                            className='grid size-7 place-items-center rounded-full text-muted hover:bg-tint hover:text-alert'
                        >
                            <Trash2 size={14}/>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

// Under a message Captain is making a plan for: before the plan card arrives
// (planning can take a while), say so, so the message doesn't look ignored.
function Planning({post}: {post: Post}) {
    const status = useStore((s) => s.runByTrigger[post.id]);
    if (status !== 'planning') {
        return null;
    }
    return (
        <div className='mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] text-muted'>
            <Dots/> Captain is working out who does what…
        </div>
    );
}

// Under a message with replies: who replied, how many, and whether an agent is still at it.
function ThreadSummary({post, onOpen}: {post: Post; onOpen: () => void}) {
    const ids = useStore((s) => s.postsByChannel[post.channelId]);
    const posts = useStore((s) => s.posts);
    const users = useStore((s) => s.users);
    const replies = useMemo(() => (ids ?? []).map((id) => posts[id]).filter((p) => p?.rootId === post.id), [ids, posts, post.id]);
    const authors = [...new Set(replies.map((r) => r.userId))].slice(0, 4);
    const working = replies.some((r) => r.props.streaming) || replies.some((r) => r.type === 'plan' && ['planning', 'running'].includes(r.props.plan?.status ?? ''));
    const pending = replies.some((r) => r.type === 'decision' && r.props.decision?.status === 'pending');
    return (
        <button type='button' onClick={onOpen} className='mt-1.5 flex items-center gap-2 rounded-xl py-1 pr-2.5 pl-1 text-[12.5px] hover:bg-tint'>
            <span className='flex -space-x-1.5'>
                {authors.map((id) => <Avatar key={id} user={users[id]} size={20} className='ring-2 ring-[var(--bg)]'/>)}
            </span>
            <span className='font-bold text-accent-text'>{post.replyCount} {post.replyCount === 1 ? 'reply' : 'replies'}</span>
            {working && <span className='inline-flex items-center gap-1.5 text-muted'><Dots/> working</span>}
            {pending && <span className='inline-flex items-center gap-1 font-semibold text-gold-text'><span className='size-1.5 rounded-full bg-gold'/>decision waiting</span>}
        </button>
    );
}

// Show avatar and name only when the author changes or after a pause.
export function isGrouped(prev: Post | undefined, post: Post): boolean {
    return Boolean(prev && prev.userId === post.userId && post.createdAt - prev.createdAt < 5 * 60 * 1000 && !prev.type && !post.type && !post.props.step);
}

type Reaction = {key: string; emoji: string; userIds: string[]};

// Reactions by Crew id (a Unicode one from before counts as its Crew id).
function groupReactions(list: {emoji: string; userIds: string[]}[]): Reaction[] {
    const out: Reaction[] = [];
    for (const r of list) {
        const key = crewId(r.emoji) ?? r.emoji;
        const same = out.find((x) => x.key === key);
        if (same) {
            same.userIds = [...new Set([...same.userIds, ...r.userIds])];
        } else {
            out.push({key, emoji: r.emoji, userIds: [...r.userIds]});
        }
    }
    return out;
}

// A reaction: the Crew emoji, then who. People are counted; an agent shows
// its face instead of adding to the count.
function ReactionPill({reaction: r, meId, pop, onToggle}: {reaction: Reaction; meId?: string; pop: boolean; onToggle: (id: CrewId) => void}) {
    const users = useStore((s) => s.users);
    const id = crewId(r.key);
    const mine = Boolean(meId && r.userIds.includes(meId));
    const bots = r.userIds.filter((u) => users[u]?.isBot);
    const people = r.userIds.length - bots.length;
    const names = r.userIds.map((u) => (u === meId ? 'You' : displayName(users[u]))).join(', ');
    const label = `${names} reacted ${id ? crewName(id) : r.key}`;
    return (
        <button
            type='button'
            disabled={!id}
            onClick={() => id && onToggle(id)}
            title={label}
            aria-label={label}
            aria-pressed={mine}
            className={`inline-flex h-6 items-center gap-1 rounded-full pr-2 pl-1.5 text-[12px] ring-1 transition-colors ${mine ? 'bg-tint ring-accent/40' : 'bg-surface ring-line hover:bg-tint'}`}
        >
            <ReactionGlyph emoji={r.key} size={16} pop={pop}/>
            {people > 0 && <span className='font-semibold text-muted'>{people}</span>}
            {bots.length > 0 && (
                <span className='flex -space-x-1'>
                    {bots.slice(0, 3).map((u) => <Avatar key={u} user={users[u]} size={14} className='ring-1 ring-[var(--surface)]'/>)}
                </span>
            )}
        </button>
    );
}

// The other twelve, in a little panel under the hover bar.
function Picker({onPick, onClose}: {onPick: (id: CrewId) => void; onClose: () => void}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const away = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        document.addEventListener('mousedown', away);
        document.addEventListener('keydown', esc);
        ref.current?.querySelector('button')?.focus();
        return () => {
            document.removeEventListener('mousedown', away);
            document.removeEventListener('keydown', esc);
        };
    }, [onClose]);
    return (
        <div ref={ref} role='menu' aria-label='More reactions' className='absolute top-9 right-0 z-30 grid grid-cols-6 gap-1 rounded-2xl bg-surface p-2 ring-1 ring-line' style={{boxShadow: 'var(--shadow-overlay)'}}>
            {CREW_MORE.map((id) => (
                <button key={id} type='button' role='menuitem' title={crewName(id)} aria-label={crewName(id)} onClick={() => onPick(id)} className='grid size-11 place-items-center rounded-xl transition-transform hover:scale-110 hover:bg-tint focus-visible:bg-tint'>
                    <Crew id={id} size={32}/>
                </button>
            ))}
        </div>
    );
}
