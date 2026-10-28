import {Check, Clock, X} from 'lucide-react';
import {useState} from 'react';

import {api, errorMessage} from '../lib/api';
import {timeOfDay} from '../lib/format';
import {canDecide, decisionOf, displayName, useStore} from '../lib/store';
import type {Post} from '../lib/types';

// "The agent prepares, a person confirms." The decided card comes back to
// everyone in the chat as a post_edited event.
export function DecisionCard({post, compact = false}: {post: Post; compact?: boolean}) {
    const decision = decisionOf(post);
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const updatePost = useStore((s) => s.updatePost);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    if (!decision) {
        return null;
    }

    const act = async (action: 'approve' | 'reject') => {
        setBusy(action);
        setError(null);
        try {
            updatePost(await api.postAction(post.id, action));
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    if (decision.status !== 'pending') {
        const approved = decision.status === 'approved';
        const expired = decision.status === 'expired';
        return (
            <div className='mt-1.5 flex items-center gap-2 rounded-2xl bg-bg-subtle px-3 py-2 text-[13px] text-muted ring-1 ring-line'>
                <span className={`grid size-5 shrink-0 place-items-center rounded-full ${approved ? 'bg-accent text-on-accent' : 'bg-tint text-muted'}`}>
                    {approved ? <Check size={12} strokeWidth={3}/> : expired ? <Clock size={12} strokeWidth={2.5}/> : <X size={12} strokeWidth={3}/>}
                </span>
                <span className='min-w-0 truncate'>
                    <span className='font-semibold text-ink'>{approved ? 'Approved' : expired ? 'Expired' : 'Rejected'}</span>
                    {decision.decidedBy && <>{' by '}{displayName(users[decision.decidedBy])}</>}
                    {decision.decidedAt ? ` · ${timeOfDay(decision.decidedAt)}` : ''}
                    <span className='text-muted'>{' — '}{decision.title}</span>
                </span>
            </div>
        );
    }

    const allowed = canDecide(decision, me, workspace);
    return (
        <div className={`mt-1.5 rounded-2xl bg-surface ring-1 ring-line ${compact ? 'p-3' : 'p-4'}`} style={{boxShadow: 'inset 3px 0 0 var(--gold)'}}>
            <div className='mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-gold-tint px-2 py-0.5 text-[11px] font-semibold text-gold-text'>
                <span className='size-1.5 rounded-full bg-gold'/>
                {allowed ? 'Needs your decision' : `Waiting for ${displayName(users[decision.requestedBy])}`}
            </div>
            <div className='text-[14px] font-bold leading-snug text-ink'>{decision.title}</div>
            {decision.reason && <p className='mt-1 text-[13px] leading-relaxed text-text'>{decision.reason}</p>}
            {decision.fields.length > 0 && (
                <dl className='mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]'>
                    {decision.fields.map((f) => (
                        <div key={f.label} className='contents'>
                            <dt className='text-muted'>{f.label}</dt>
                            <dd className={`font-medium whitespace-pre-wrap text-ink ${compact ? 'scroll-quiet max-h-32 overflow-y-auto' : ''}`}>{f.value}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {allowed && (
                <div className='mt-3 flex items-center gap-2'>
                    <button
                        type='button'
                        disabled={busy !== null}
                        onClick={() => void act('approve')}
                        className='inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-bold text-on-accent transition-opacity disabled:opacity-60'
                        style={{boxShadow: 'var(--shadow-send)'}}
                    >
                        <Check size={14} strokeWidth={2.5}/>
                        {busy === 'approve' ? 'Approving…' : 'Approve'}
                    </button>
                    <button
                        type='button'
                        disabled={busy !== null}
                        onClick={() => void act('reject')}
                        className='inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-semibold text-text ring-1 ring-line transition-colors hover:bg-tint disabled:opacity-60'
                    >
                        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
                    </button>
                </div>
            )}
            {error && <p className='mt-2 text-[12px] text-alert'>{error}</p>}
        </div>
    );
}
