// Home: a dashboard of what's going on. Tasks agents are working on (live),
// what's waiting on you, what finished, and, for owners and admins, tokens
// burned. Clicking a task opens its thread.

import {AlertTriangle, Check, CircleSlash, Clock, KeyRound, ListChecks, LoaderCircle, UserPlus, X} from 'lucide-react';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {portraitSrc} from '../components/Avatar';
import {ChatIcon} from '../components/ChatIcon';
import {plain} from '../components/Markup';
import {api, errorMessage} from '../lib/api';
import {shortWhen} from '../lib/format';
import {isTauri} from '../lib/native';
import {openSetup} from '../lib/setup';
import {useShortcutLabels} from '../lib/shortcuts';
import {channelTitle, decisionOf, displayName, needsYou, otherUserId, useStore} from '../lib/store';
import type {ActivityRun, Agent, Dashboard, DashboardUsage} from '../lib/types';

const REFRESH_MS = 30_000;

const compact = new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1});
const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const dayName = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric'});

function ago(ts: number, now: number): string {
    const m = Math.max(0, Math.round((now - ts) / 60_000));
    if (m < 1) {
        return 'just now';
    }
    if (m < 60) {
        return `${m} min ago`;
    }
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} h ago` : shortWhen(ts);
}

function greeting(): string {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// The dashboard's data: fetched on open, again whenever a task changes, and
// every 30 seconds.
function useDashboard(): {data: Dashboard | null; error: string | null; now: number} {
    const workspace = useStore((s) => s.workspace);
    const runs = useStore((s) => s.runs);
    const connection = useStore((s) => s.connection);
    const [data, setData] = useState<Dashboard | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());
    const wsId = workspace?.id;

    const load = useCallback(async () => {
        if (!wsId) {
            return;
        }
        try {
            const next = await api.dashboard(wsId);
            // Switched workspaces while this was loading: drop it.
            if (useStore.getState().workspace?.id !== wsId) {
                return;
            }
            setData(next);
            setError(null);
        } catch (e) {
            setError(errorMessage(e));
        }
        setNow(Date.now());
    }, [wsId]);

    useEffect(() => {
        setData(null);
        void load();
        const t = window.setInterval(() => void load(), REFRESH_MS);
        return () => window.clearInterval(t);
    }, [load]);

    // A task started, moved or finished: refresh shortly after.
    const first = useRef(true);
    useEffect(() => {
        if (first.current) {
            first.current = false;
            return undefined;
        }
        const t = window.setTimeout(() => void load(), 600);
        return () => window.clearTimeout(t);
    }, [runs, connection, load]);

    return {data, error, now};
}

export function Overview({onInvite, onModels}: {onInvite: () => void; onModels: () => void}) {
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const demoMode = useStore((s) => s.demoMode);
    const agents = useStore((s) => s.agents);
    const addChannel = useStore((s) => s.addChannel);
    const setActive = useStore((s) => s.setActiveChannel);
    const channels = useStore((s) => s.channels);
    const members = useStore((s) => s.members);
    const posts = useStore((s) => s.posts);
    const postsByChannel = useStore((s) => s.postsByChannel);
    const keys = useShortcutLabels();
    const {data, error, now} = useDashboard();
    const waiting = useMemo(() => needsYou({channels, members, posts, postsByChannel, me, workspace}), [channels, members, posts, postsByChannel, me, workspace]);
    const captain = Object.values(agents).find((a) => a.isCoordinator);
    const admin = Boolean(data?.usage);

    const [opening, setOpening] = useState(false);
    const askCaptain = async () => {
        if (!captain || !workspace || opening) {
            return;
        }
        // Your conversation with Captain, if it's already loaded; else ask for it.
        const known = Object.values(useStore.getState().channels).find((c) => c.type === 'D' && me && otherUserId(c, me.id) === captain.userId);
        if (known) {
            setActive(known.id);
            return;
        }
        setOpening(true);
        try {
            const c = await api.directMessage(workspace.id, captain.userId);
            addChannel(c);
            setActive(c.id);
        } finally {
            setOpening(false);
        }
    };
    const openRun = (r: ActivityRun) => {
        setActive(r.channelId);
        // Answered in a thread, or right in the conversation (a direct message, or a private chat with agents).
        const root = r.rootPostId;
        if (root) {
            useStore.getState().openThread(root);
        }
    };

    return (
        <div className='scroll-quiet flex-1 overflow-y-auto'>
            <div data-tauri-drag-region className='mx-auto max-w-[980px] px-7 pt-12 pb-10'>
                <header data-tauri-drag-region className='flex flex-wrap items-end gap-3'>
                    <div className='min-w-0 flex-1'>
                        <h1 className='text-[26px] font-extrabold tracking-tight text-ink'>{greeting()}, {me?.displayName.split(' ')[0]}</h1>
                        <p className='mt-0.5 text-[13.5px] text-muted'>{dayName.format(now)} · what your agents are doing in {workspace?.name}</p>
                    </div>
                    {captain && (
                        <button type='button' onClick={() => void askCaptain()} className='inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-[13px] font-bold text-on-accent' style={{boxShadow: 'var(--shadow-send)'}}>
                            <img src='/captain-mark.png' alt='' className='size-4 brightness-0 invert'/> {opening ? 'Opening…' : 'Ask Captain'}
                        </button>
                    )}
                    {workspace?.role !== 'guest' && (
                        <button type='button' onClick={onInvite} className='inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold text-text ring-1 ring-line hover:bg-tint'>
                            <UserPlus size={14}/> Invite
                        </button>
                    )}
                    <button type='button' onClick={openSetup} className='inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold text-text ring-1 ring-line hover:bg-tint'>
                        <ListChecks size={14}/> Get started
                    </button>
                </header>

                {demoMode && (
                    <div className='mt-5 flex items-center gap-3 rounded-2xl bg-gold-tint p-3.5 ring-1 ring-gold/30'>
                        <span className='grid size-8 shrink-0 place-items-center rounded-xl bg-surface text-gold-text'><KeyRound size={16}/></span>
                        <span className='min-w-0 flex-1'>
                            <span className='block text-[13.5px] font-bold text-ink'>{me?.instanceAdmin ? 'Connect a model' : 'Agents are in demo mode'}</span>
                            <span className='block text-[12.5px] text-gold-text'>
                                {me?.instanceAdmin ? 'Paste an OpenRouter key and every agent starts answering for real.' : 'They give sample answers until whoever runs this server adds a model key.'}
                            </span>
                        </span>
                        {me?.instanceAdmin && <button type='button' onClick={onModels} className='inline-flex h-9 shrink-0 items-center rounded-full bg-accent px-4 text-[13px] font-bold text-on-accent'>Add key</button>}
                    </div>
                )}

                {/* Headline numbers */}
                <div className='mt-6 grid grid-cols-2 gap-3 md:grid-cols-4'>
                    <Tile label='In progress' value={data?.counts.active} note={data ? (data.counts.waiting ? `${data.counts.waiting} waiting for a decision` : 'tasks agents are on') : ''}/>
                    <Tile label='Waiting on you' value={data ? waiting.length : undefined} note={waiting.length ? 'decisions, mentions, messages' : 'all clear'} tone={waiting.length ? 'gold' : undefined}/>
                    <Tile label='Done today' value={data?.counts.doneToday} note={data ? (data.counts.failedToday ? `${data.counts.failedToday} didn't finish` : `${data.counts.doneWeek} this week`) : ''}/>
                    {admin ? (
                        <Tile label='Tokens today' value={data?.usage ? compact.format(data.usage.today.tokensIn + data.usage.today.tokensOut) : undefined} note={data?.usage ? `${usd(data.usage.today.usd)} · ${data.usage.today.calls} model calls` : ''}/>
                    ) : (
                        <Tile label='Done this week' value={data?.counts.doneWeek} note='tasks finished'/>
                    )}
                </div>

                {error && !data && <p className='mt-4 text-[13px] text-alert'>Couldn&apos;t load the dashboard: {error}</p>}

                <div className='mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]'>
                    <Card title='In progress' count={data?.active.length}>
                        {!data ? <Skeleton rows={2}/> : data.active.length === 0 ? (
                            <Empty>No agent is working on anything. Mention one in a chat, or ask Captain.</Empty>
                        ) : (
                            <ul className='space-y-2'>
                                {data.active.map((r) => <ActiveTask key={r.id} run={r} agents={agents} now={now} showTokens={admin} onOpen={() => openRun(r)}/>)}
                            </ul>
                        )}
                    </Card>
                    <Card title='Waiting on you' count={waiting.length} tone={waiting.length ? 'gold' : undefined}>
                        {waiting.length === 0 ? <Empty>Nothing needs you right now. Approvals and mentions show up here.</Empty> : (
                            <ul className='space-y-1.5'>
                                {waiting.slice(0, 6).map((item) => {
                                    const channel = channels[item.channelId];
                                    const post = item.postId ? posts[item.postId] : undefined;
                                    const d = decisionOf(post);
                                    const who = post ? displayName(useStore.getState().users[post.userId]) : '';
                                    const line = d ? d.title : item.kind === 'dm' ? plain(post?.message ?? '') || 'New message' : `${who} mentioned you`;
                                    return (
                                        <li key={`${item.channelId}:${item.postId}`}>
                                            <button type='button' onClick={() => {
                                                setActive(item.channelId);
                                                if (post?.rootId) {
                                                    useStore.getState().openThread(post.rootId);
                                                }
                                            }} className='flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-tint'>
                                                <ChatIcon channel={channel} size={24}/>
                                                <span className='min-w-0 flex-1'>
                                                    <span className='block truncate text-[12.5px] font-bold text-ink'>{d ? 'Decision' : item.kind === 'dm' ? 'Message' : 'Mention'} · {channelTitle(channel, me?.id, useStore.getState().users)}</span>
                                                    <span className='block truncate text-[12.5px] text-muted'>{line}</span>
                                                </span>
                                                {d && <span className='mt-0.5 shrink-0 rounded-full bg-gold-tint px-2 py-0.5 text-[11px] font-bold text-gold-text'>Needs a yes</span>}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </Card>
                </div>

                {data?.usage && <Tokens usage={data.usage} agents={agents} onModels={onModels}/>}

                <Card title='Done recently' count={data?.recent.length} className='mt-4'>
                    {!data ? <Skeleton rows={3}/> : data.recent.length === 0 ? <Empty>Finished tasks from the past week show up here.</Empty> : (
                        <ul className='-mx-1'>
                            {data.recent.map((r) => <DoneTask key={r.id} run={r} agents={agents} now={now} showTokens={admin} onOpen={() => openRun(r)}/>)}
                        </ul>
                    )}
                </Card>

                <p className='mt-6 text-center text-[12px] text-muted'>
                    Name one agent and it answers · name two or more (&ldquo;@researcher @writer …&rdquo;) and Captain splits the work between them
                    {isTauri ? ` · ${keys.panel} quick panel · hold ${keys.talk} to talk` : ''}
                </p>
            </div>
        </div>
    );
}

// ------------------------------------------------------------ pieces

function Tile({label, value, note, tone}: {label: string; value: number | string | undefined; note: string; tone?: 'gold'}) {
    return (
        <div className='rounded-2xl bg-surface p-3.5 ring-1 ring-line' style={{boxShadow: 'var(--shadow-control)'}}>
            <div className='text-[12px] font-semibold text-muted'>{label}</div>
            <div className={`mt-0.5 text-[26px] leading-tight font-extrabold tracking-tight ${tone === 'gold' && value ? 'text-gold-text' : 'text-ink'}`}>
                {value === undefined ? <span className='inline-block h-6 w-10 animate-pulse rounded-md bg-tint align-middle'/> : value}
            </div>
            <div className='truncate text-[12px] text-muted'>{note}</div>
        </div>
    );
}

function Card({title, count, tone, className = '', children}: {title: string; count?: number; tone?: 'gold'; className?: string; children: ReactNode}) {
    return (
        <section className={`rounded-2xl bg-surface p-4 ring-1 ring-line ${className}`} style={{boxShadow: 'var(--shadow-control)'}}>
            <h2 className='mb-2.5 flex items-center gap-2 text-[14px] font-extrabold text-ink'>
                {title}
                {count !== undefined && count > 0 && (
                    <span className={`rounded-full px-1.5 text-[11.5px] font-bold ${tone === 'gold' ? 'bg-gold-tint text-gold-text' : 'bg-tint text-accent-text'}`}>{count}</span>
                )}
            </h2>
            {children}
        </section>
    );
}

function Empty({children}: {children: ReactNode}) {
    return <p className='rounded-xl bg-bg-subtle px-3 py-3 text-[12.5px] text-muted'>{children}</p>;
}

function Skeleton({rows}: {rows: number}) {
    return (
        <div className='space-y-2'>
            {Array.from({length: rows}, (_, i) => <div key={i} className='h-12 animate-pulse rounded-xl bg-tint/70'/>)}
        </div>
    );
}

// The agents on a task: the team Captain coordinates, or the one agent.
function Faces({run, agents}: {run: ActivityRun; agents: Record<string, Agent>}) {
    const ids = run.team?.length ? [run.agentId, ...run.team] : [...new Set([run.agentId, ...run.steps.map((s) => s.agentId)])];
    const list = ids.map((id) => agents[id]).filter(Boolean).slice(0, 4);
    return (
        <span className='flex shrink-0 -space-x-1.5'>
            {list.map((a) => (
                <span key={a.id} title={a.name} className='grid size-7 place-items-center overflow-hidden rounded-lg bg-white ring-2 ring-surface'>
                    <img src={portraitSrc(a.portrait, a.handle)} alt={a.name} className={a.isCoordinator ? 'size-[72%]' : 'size-full'}/>
                </span>
            ))}
        </span>
    );
}

function who(run: ActivityRun, agents: Record<string, Agent>): string {
    const lead = agents[run.agentId];
    if (run.team?.length) {
        const names = run.team.map((id) => agents[id]?.name ?? 'agent');
        return `Captain with ${names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`;
    }
    if (run.kind === 'plan') {
        return `Captain + ${new Set(run.steps.map((s) => s.agentId)).size} agents`;
    }
    return lead?.name ?? 'Agent';
}

function useWhere(channelId: string): string {
    const channel = useStore((s) => s.channels[channelId]);
    const meId = useStore((s) => s.me?.id);
    const users = useStore((s) => s.users);
    if (!channel) {
        return '';
    }
    const title = channelTitle(channel, meId, users);
    return title.replace(/^#/, '');
}

const STATUS: Record<string, {label: string; icon: ReactNode; cls: string}> = {
    queued: {label: 'Starting', icon: <Clock size={12}/>, cls: 'bg-tint text-accent-text'},
    planning: {label: 'Planning', icon: <LoaderCircle size={12} className='animate-spin'/>, cls: 'bg-tint text-accent-text'},
    running: {label: 'Working', icon: <LoaderCircle size={12} className='animate-spin'/>, cls: 'bg-tint text-accent-text'},
    waiting_approval: {label: 'Waiting for a decision', icon: <Clock size={12}/>, cls: 'bg-gold-tint text-gold-text'},
};

function ActiveTask({run, agents, now, showTokens, onOpen}: {run: ActivityRun; agents: Record<string, Agent>; now: number; showTokens: boolean; onOpen: () => void}) {
    const where = useWhere(run.channelId);
    const st = STATUS[run.status] ?? STATUS.running;
    const total = run.steps.length;
    const done = run.steps.filter((s) => s.status === 'succeeded').length;
    const working = run.steps.find((s) => s.status === 'running');
    return (
        <li>
            <button type='button' onClick={onOpen} className='w-full rounded-xl bg-bg-subtle px-3 py-2.5 text-left ring-1 ring-line/70 transition-colors hover:bg-tint'>
                <div className='flex items-start gap-2.5'>
                    <Faces run={run} agents={agents}/>
                    <div className='min-w-0 flex-1'>
                        <div className='line-clamp-2 text-[13px] leading-snug font-bold text-ink'>{run.goal || 'A reply'}</div>
                        <div className='mt-0.5 truncate text-[12px] text-muted'>
                            {who(run, agents)}{where ? ` · ${where}` : ''} · {ago(run.createdAt, now)}{showTokens && run.tokens ? ` · ${compact.format(run.tokens)} tokens` : ''}
                        </div>
                    </div>
                    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.icon}{st.label}</span>
                </div>
                {total > 1 && (
                    <div className='mt-2 flex items-center gap-2'>
                        <span className='h-1 flex-1 overflow-hidden rounded-full bg-tint'>
                            <span className='block h-full rounded-full bg-accent transition-all duration-500' style={{width: `${(done / total) * 100}%`}}/>
                        </span>
                        <span className='shrink-0 text-[11.5px] text-muted'>{done}/{total}{working ? ` · ${agents[working.agentId]?.name ?? 'agent'}: ${working.title}` : ''}</span>
                    </div>
                )}
            </button>
        </li>
    );
}

function DoneTask({run, agents, now, showTokens, onOpen}: {run: ActivityRun; agents: Record<string, Agent>; now: number; showTokens: boolean; onOpen: () => void}) {
    const where = useWhere(run.channelId);
    const ok = run.status === 'succeeded';
    const icon = ok ? (
        <span className='grid size-5 place-items-center rounded-full bg-accent text-on-accent'><Check size={11} strokeWidth={3}/></span>
    ) : run.status === 'failed' ? (
        <span className='grid size-5 place-items-center rounded-full bg-alert/15 text-alert'><X size={11} strokeWidth={3}/></span>
    ) : (
        <span className='grid size-5 place-items-center rounded-full bg-tint text-muted'><CircleSlash size={11} strokeWidth={2.5}/></span>
    );
    return (
        <li>
            <button type='button' onClick={onOpen} className='flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-tint'>
                <span className='shrink-0' title={ok ? 'Done' : run.status === 'failed' ? 'Didn\'t finish' : 'Stopped'}>{icon}</span>
                <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[13px] font-semibold text-ink'>{run.goal || 'A reply'}</span>
                    <span className='block truncate text-[12px] text-muted'>
                        {who(run, agents)}{where ? ` · ${where}` : ''}{!ok && run.error ? ` · ${run.error}` : ''}
                    </span>
                </span>
                {showTokens && (
                    <span className='shrink-0 text-right text-[12px] text-muted tabular-nums'>
                        {compact.format(run.tokens)} tokens<br/>{usd(run.costUsd)}
                    </span>
                )}
                <span className='w-16 shrink-0 text-right text-[12px] text-muted'>{ago(run.updatedAt, now)}</span>
            </button>
        </li>
    );
}

// ------------------------------------------------------------ tokens

function Tokens({usage, agents, onModels}: {usage: DashboardUsage; agents: Record<string, Agent>; onModels: () => void}) {
    const month = usage.month.tokensIn + usage.month.tokensOut;
    const week = usage.week.tokensIn + usage.week.tokensOut;
    const budget = usage.budgetUsd;
    const share = budget ? usage.month.usd / Math.max(0.0001, budget) : 0;
    const meter = share >= 1 ? 'bg-alert' : share >= 0.8 ? 'bg-gold' : 'bg-accent';
    const topAgents = usage.byAgent.filter((a) => a.tokens > 0).slice(0, 5);
    const maxAgent = Math.max(1, ...topAgents.map((a) => a.tokens));
    return (
        <Card title='Tokens burned' className='mt-4'>
            <div className='grid gap-5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1fr)]'>
                <div>
                    <div className='text-[12px] font-semibold text-muted'>This month</div>
                    <div className='text-[30px] leading-tight font-extrabold tracking-tight text-ink'>{compact.format(month)}</div>
                    <div className='text-[12px] text-muted'>{compact.format(usage.month.tokensIn)} in · {compact.format(usage.month.tokensOut)} out</div>
                    <div className='mt-3 text-[12.5px] text-text'>{usd(usage.month.usd)}{budget !== null ? ` of $${budget.toFixed(0)} budget` : ' spent, no budget'}</div>
                    {budget !== null && (
                        <div className='mt-1 h-1.5 overflow-hidden rounded-full bg-tint'>
                            <div className={`h-full rounded-full ${meter}`} style={{width: `${Math.min(100, share * 100)}%`}}/>
                        </div>
                    )}
                    <div className='mt-3 text-[12px] text-muted'>Past 7 days: {compact.format(week)} tokens · {usd(usage.week.usd)}</div>
                    {usage.errorsToday > 0 && (
                        <button type='button' onClick={onModels} className='mt-2 inline-flex items-center gap-1 text-left text-[12px] font-semibold text-gold-text hover:underline'>
                            <AlertTriangle size={12}/> {usage.errorsToday} model error{usage.errorsToday === 1 ? '' : 's'} today, mostly retried. See why
                        </button>
                    )}
                </div>
                <DailyChart daily={usage.daily}/>
                <div>
                    <div className='mb-1.5 text-[12px] font-semibold text-muted'>By agent, this month</div>
                    {topAgents.length === 0 ? <p className='text-[12px] text-muted'>No model calls yet.</p> : (
                        <ul className='space-y-1.5'>
                            {topAgents.map((a) => {
                                const agent = a.agentId ? agents[a.agentId] : undefined;
                                return (
                                    <li key={a.agentId ?? 'other'} className='grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 text-[12px]'>
                                        <img src={portraitSrc(agent?.portrait, agent?.handle)} alt='' className='size-[18px] rounded-md ring-1 ring-line'/>
                                        <span className='truncate font-semibold text-ink'>{agent?.name ?? (a.agentId ? 'Removed agent' : 'Other')}</span>
                                        <span className='text-muted tabular-nums'>{compact.format(a.tokens)}</span>
                                        <span/>
                                        <span className='col-span-2 h-1 overflow-hidden rounded-full bg-tint'>
                                            <span className='block h-full rounded-full bg-[var(--chart-bar)]' style={{width: `${(a.tokens / maxAgent) * 100}%`}}/>
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </Card>
    );
}

// Tokens per day for the past 14 days: one series, so no legend; hover a
// column for the day's numbers. A hidden table carries the same data.
function DailyChart({daily}: {daily: DashboardUsage['daily']}) {
    const [hover, setHover] = useState<number | null>(null);
    const W = 360;
    const H = 132;
    const top = 10;
    const bottom = 20;
    const left = 32;
    const plotH = H - top - bottom;
    const max = Math.max(...daily.map((d) => d.tokens), 0);
    const tick = niceMax(max);
    const slot = (W - left) / daily.length;
    const barW = Math.min(16, slot - 2);
    const y = (v: number) => top + plotH - (tick ? (v / tick) * plotH : 0);
    const shown = hover !== null ? daily[hover] : null;
    const short = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
    return (
        <div className='min-w-0'>
            <div className='mb-1.5 flex items-baseline gap-2 text-[12px]'>
                <span className='font-semibold text-muted'>Tokens per day</span>
                <span className='ml-auto truncate text-muted'>
                    {shown ? `${dayName.format(shown.day)} · ${compact.format(shown.tokens)} tokens · ${usd(shown.usd)}` : 'past 14 days'}
                </span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className='block w-full' role='img' aria-label='Tokens per day, past 14 days' onMouseLeave={() => setHover(null)}>
                {[0, tick / 2, tick].map((v) => (
                    <g key={v}>
                        <line x1={left} x2={W} y1={y(v)} y2={y(v)} stroke='var(--line)' strokeWidth={1}/>
                        <text x={left - 6} y={y(v) + 3.5} textAnchor='end' fontSize={10} fill='var(--muted)'>{compact.format(v)}</text>
                    </g>
                ))}
                {daily.map((d, i) => {
                    const x = left + i * slot + (slot - barW) / 2;
                    const h = Math.max(0, y(0) - y(d.tokens));
                    const r = Math.min(4, h, barW / 2);
                    return (
                        <g key={d.day} onMouseEnter={() => setHover(i)}>
                            <rect x={left + i * slot} y={top} width={slot} height={plotH} fill='transparent'/>
                            {h > 0 && (
                                <path
                                    d={`M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + barW - r} Q${x + barW},${y(0) - h} ${x + barW},${y(0) - h + r} V${y(0)} Z`}
                                    fill='var(--chart-bar)'
                                    opacity={hover === null || hover === i ? 1 : 0.45}
                                />
                            )}
                        </g>
                    );
                })}
                {[0, 7, daily.length - 1].map((i) => daily[i] && (
                    <text key={i} x={i === daily.length - 1 ? W : left + i * slot + slot / 2} y={H - 5} textAnchor={i === daily.length - 1 ? 'end' : 'middle'} fontSize={10} fill='var(--muted)'>
                        {i === daily.length - 1 ? 'Today' : short.format(daily[i].day)}
                    </text>
                ))}
            </svg>
            <table className='sr-only'>
                <caption>Tokens per day</caption>
                <thead><tr><th>Day</th><th>Tokens</th><th>Cost</th></tr></thead>
                <tbody>{daily.map((d) => <tr key={d.day}><td>{dayName.format(d.day)}</td><td>{d.tokens}</td><td>{usd(d.usd)}</td></tr>)}</tbody>
            </table>
        </div>
    );
}

// A round top for the axis: 0 → 1K, 1,840 → 2K, 23K → 25K.
function niceMax(v: number): number {
    if (v <= 0) {
        return 1000;
    }
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
        if (m * p >= v) {
            return m * p;
        }
    }
    return 10 * p;
}
