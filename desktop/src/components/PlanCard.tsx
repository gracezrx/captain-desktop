import {Check, CircleDashed, Clock, LoaderCircle, Square, X} from 'lucide-react';
import {useState} from 'react';

import {api, errorMessage} from '../lib/api';
import {agentForUser, useStore} from '../lib/store';
import type {PlanStepStatus, Post} from '../lib/types';

import {portraitSrc} from './Avatar';

const LABEL: Record<string, string> = {
    queued: 'Queued', planning: 'Planning', running: 'Working', waiting_approval: 'Waiting for a decision', succeeded: 'Done', failed: 'Didn\'t finish', cancelled: 'Stopped',
};

function StepIcon({status}: {status: PlanStepStatus}) {
    switch (status) {
    case 'succeeded':
        return <span className='grid size-5 place-items-center rounded-full bg-accent text-on-accent'><Check size={12} strokeWidth={3}/></span>;
    case 'running':
        return <LoaderCircle size={18} className='animate-spin text-accent'/>;
    case 'waiting_approval':
        return <Clock size={18} className='text-gold'/>;
    case 'failed':
        return <span className='grid size-5 place-items-center rounded-full bg-alert/15 text-alert'><X size={12} strokeWidth={3}/></span>;
    case 'skipped':
    case 'cancelled':
        return <span className='grid size-5 place-items-center rounded-full bg-tint text-muted'><X size={12} strokeWidth={3}/></span>;
    default:
        return <CircleDashed size={18} className='text-muted'/>;
    }
}

function joinNames(names: string[]): string {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// Captain's plan: who does what, in which order, live.
export function PlanCard({post, compact = false, onOpenStep}: {post: Post; compact?: boolean; onOpenStep?: (postId: string) => void}) {
    const plan = post.props.plan;
    const agents = useStore((s) => s.agents);
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const liveStatus = useStore((s) => (plan ? s.runs[plan.runId] : undefined));
    const askedBy = useStore((s) => (post.rootId ? s.posts[post.rootId]?.userId : undefined));
    const [stopping, setStopping] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (!plan) {
        return null;
    }
    const status = liveStatus ?? plan.status;
    const active = ['queued', 'planning', 'running', 'waiting_approval'].includes(status);
    const done = plan.steps.filter((s) => s.status === 'succeeded').length;
    // The person who asked (the thread's first message, or you in a direct message) or an admin.
    const canStop = active && (workspace?.role === 'owner' || workspace?.role === 'admin' || !post.rootId || askedBy === me?.id);

    const stop = async () => {
        setStopping(true);
        setError(null);
        try {
            await api.cancelRun(plan.runId);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setStopping(false);
        }
    };

    return (
        <div className={`mt-1.5 rounded-2xl bg-surface ring-1 ring-line ${compact ? 'p-3' : 'p-4'}`}>
            <div className='flex items-start gap-2'>
                <div className='min-w-0 flex-1'>
                    <div className='text-[11px] font-bold tracking-wide text-accent-text uppercase'>Plan · {LABEL[status] ?? status}{active ? '' : ` · ${done}/${plan.steps.length}`}</div>
                    <div className='mt-0.5 text-[14px] font-bold leading-snug text-ink'>{plan.goal}</div>
                </div>
                {canStop && (
                    <button type='button' onClick={() => void stop()} disabled={stopping} className='inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-muted ring-1 ring-line hover:bg-tint hover:text-ink disabled:opacity-60'>
                        <Square size={10} fill='currentColor'/> {stopping ? 'Stopping…' : 'Stop'}
                    </button>
                )}
            </div>
            {plan.coordinating && plan.coordinating.length > 0 && (
                <p className='mt-1 text-[12px] text-muted'>
                    Captain is coordinating {joinNames(plan.coordinating.map((id) => `@${agents[id]?.handle ?? 'agent'}`))}: each takes a part, then Captain posts one combined answer.
                </p>
            )}
            <div className='mt-2.5 h-1 overflow-hidden rounded-full bg-tint'>
                <div className='h-full rounded-full bg-accent transition-all duration-500' style={{width: `${(done / Math.max(1, plan.steps.length)) * 100}%`}}/>
            </div>
            <ol className='mt-2.5 space-y-1'>
                {plan.steps.map((step) => {
                    const agent = agents[step.agentId] ?? agentForUser(agents, step.agentId);
                    const clickable = Boolean(step.postId && onOpenStep);
                    return (
                        <li key={step.id}>
                            <button
                                type='button'
                                disabled={!clickable}
                                onClick={() => step.postId && onOpenStep?.(step.postId)}
                                className={`flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1 text-left ${clickable ? 'hover:bg-tint' : 'cursor-default'}`}
                            >
                                <span className='grid size-5 shrink-0 place-items-center'><StepIcon status={step.status}/></span>
                                <img src={portraitSrc(agent?.portrait, agent?.handle)} alt='' className='size-5 shrink-0 rounded-md ring-1 ring-line'/>
                                <span className={`min-w-0 flex-1 truncate text-[13px] ${step.status === 'running' ? 'font-bold text-ink' : step.status === 'succeeded' ? 'text-text' : 'text-muted'}`}>
                                    {step.title}
                                </span>
                                <span className='shrink-0 text-[11.5px] text-muted'>@{agent?.handle ?? 'agent'}</span>
                            </button>
                        </li>
                    );
                })}
            </ol>
            {error && <p className='mt-2 text-[12px] text-alert'>{error}</p>}
        </div>
    );
}
