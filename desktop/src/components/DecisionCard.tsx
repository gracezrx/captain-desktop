import type {Post} from '@mattermost/types/posts';
import {Check, X} from 'lucide-react';
import {useState} from 'react';

import {timeOfDay} from '../lib/format';
import {client, errorMessage} from '../lib/mm';
import {decisionOf, displayName, useStore} from '../lib/store';

type Action = {id: string; name: string; cookie?: string};

// "The agent prepares, a person confirms." Buttons run Mattermost's
// interactive-message callback, which reaches the Captain bridge; the
// decided card comes back as a post_edited event for everyone in the chat.
export function DecisionCard({post, compact = false}: {post: Post; compact?: boolean}) {
    const decision = decisionOf(post);
    const users = useStore((s) => s.users);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    if (!decision) {
        return null;
    }

    const actions = ((post.props?.attachments as {actions?: Action[]}[] | undefined)?.[0]?.actions ?? []);
    const act = async (id: string) => {
        setBusy(id);
        setError(null);
        try {
            const cookie = actions.find((a) => a.id === id)?.cookie ?? '';
            await client.doPostActionWithCookie(post.id, id, cookie);
        } catch (e) {
            setError(errorMessage(e));
            setBusy(null);
        }
    };

    if (decision.status !== 'pending') {
        const approved = decision.status === 'approved';
        return (
            <div className='mt-1.5 flex items-center gap-2 rounded-2xl bg-bg-subtle px-3 py-2 text-[13px] text-muted ring-1 ring-line'>
                <span className={`grid size-5 place-items-center rounded-full ${approved ? 'bg-accent text-on-accent' : 'bg-tint text-muted'}`}>
                    {approved ? <Check size={12} strokeWidth={3}/> : <X size={12} strokeWidth={3}/>}
                </span>
                <span className='min-w-0 truncate'>
                    <span className='font-semibold text-ink'>{approved ? 'Approved' : 'Rejected'}</span>
                    {' by '}{displayName(users[decision.decided_by])}{decision.decided_at ? ` · ${timeOfDay(decision.decided_at)}` : ''}
                    <span className='text-muted'>{' — '}{decision.title}</span>
                </span>
            </div>
        );
    }

    return (
        <div className={`mt-1.5 rounded-2xl bg-surface ring-1 ring-line ${compact ? 'p-3' : 'p-4'}`} style={{boxShadow: 'inset 3px 0 0 var(--gold)'}}>
            <div className='mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-gold-tint px-2 py-0.5 text-[11px] font-semibold text-gold-text'>
                <span className='size-1.5 rounded-full bg-gold'/>
                Needs your decision
            </div>
            <div className='text-[14px] font-semibold leading-snug text-ink'>{decision.title}</div>
            {decision.reason && <p className='mt-1 text-[13px] leading-relaxed text-text'>{decision.reason}</p>}
            {decision.fields?.length > 0 && (
                <dl className='mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]'>
                    {decision.fields.map((f) => (
                        <div key={f.label} className='contents'>
                            <dt className='text-muted'>{f.label}</dt>
                            <dd className='font-medium text-ink'>{f.value}</dd>
                        </div>
                    ))}
                </dl>
            )}
            <div className='mt-3 flex items-center gap-2'>
                <button
                    type='button'
                    disabled={busy !== null}
                    onClick={() => act('approve')}
                    className='inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-on-accent transition-opacity disabled:opacity-60'
                    style={{boxShadow: 'var(--shadow-send)'}}
                >
                    <Check size={14} strokeWidth={2.5}/>
                    {busy === 'approve' ? 'Approving…' : 'Approve'}
                </button>
                <button
                    type='button'
                    disabled={busy !== null}
                    onClick={() => act('reject')}
                    className='inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-semibold text-text ring-1 ring-line transition-colors hover:bg-tint disabled:opacity-60'
                >
                    {busy === 'reject' ? 'Rejecting…' : 'Reject'}
                </button>
                <span className='ml-auto text-[11px] text-muted'>Runs as you</span>
            </div>
            {error && <p className='mt-2 text-[12px] text-alert'>{error}</p>}
        </div>
    );
}
