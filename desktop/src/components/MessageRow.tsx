import type {Post} from '@mattermost/types/posts';
import {CornerDownRight} from 'lucide-react';

import {timeOfDay} from '../lib/format';
import {client} from '../lib/mm';
import {decisionOf, displayName, fileInfosOf, useStore} from '../lib/store';

import {AuthedImage} from './AuthedImage';
import {Avatar} from './Avatar';
import {DecisionCard} from './DecisionCard';
import {Markup} from './Markup';

type Props = {
    post: Post;
    grouped?: boolean; // same author a moment ago: hide avatar and name
    compact?: boolean; // the menu bar panel
    onOpenImage?: (url: string) => void;
};

export function MessageRow({post, grouped = false, compact = false, onOpenImage}: Props) {
    const user = useStore((s) => s.users[post.user_id]);
    const me = useStore((s) => s.me);
    const root = useStore((s) => (post.root_id ? s.posts[post.root_id] : undefined));
    const rootAuthor = useStore((s) => (root ? s.users[root.user_id] : undefined));
    const mine = post.user_id === me?.id;
    const isAgent = Boolean(user?.is_bot);
    const pending = post.id === post.pending_post_id;
    const files = fileInfosOf(post);
    const size = compact ? 26 : 34;

    return (
        <div className={`group flex gap-2.5 ${grouped ? 'mt-1' : compact ? 'mt-3' : 'mt-4'}`}>
            <div style={{width: size}} className='shrink-0'>
                {!grouped && <Avatar user={user} size={size}/>}
            </div>
            <div className='min-w-0 flex-1'>
                {!grouped && (
                    <div className='flex items-baseline gap-2'>
                        <span className={`font-bold text-ink ${compact ? 'text-[12.5px]' : 'text-[13.5px]'}`}>{displayName(user)}</span>
                        {isAgent && <span className='rounded-full bg-tint px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-accent-text'>agent</span>}
                        <span className='text-[11px] text-muted'>{timeOfDay(post.create_at)}</span>
                    </div>
                )}
                {root && !compact && (
                    <div className='mt-0.5 flex items-center gap-1 text-[11.5px] text-muted'>
                        <CornerDownRight size={12}/>
                        <span className='truncate'>replying to {displayName(rootAuthor)}: {root.message.slice(0, 70) || 'an attachment'}</span>
                    </div>
                )}
                {post.message && (
                    <div
                        className={`mt-1 inline-block max-w-full rounded-2xl rounded-tl-md px-3 py-2 leading-relaxed break-words ${compact ? 'text-[13px]' : 'text-[14px]'} ${mine ? 'bg-msg-human text-text' : isAgent ? 'bg-msg-agent text-text' : 'bg-bg-subtle text-text'} ${pending ? 'opacity-60' : ''}`}
                    >
                        <Markup text={post.message} meUsername={me?.username}/>
                    </div>
                )}
                {post.failed && <div className='mt-1 text-[12px] text-alert'>Not sent. Check your connection.</div>}
                {files.length > 0 && (
                    <div className='mt-1.5 flex flex-wrap gap-2'>
                        {files.map((f) =>
                            (f.mime_type?.startsWith('image/') || f.has_preview_image ? (
                                <AuthedImage
                                    key={f.id}
                                    src={client.getFilePreviewUrl(f.id, 0)}
                                    alt={f.name}
                                    onClick={onOpenImage ? () => onOpenImage(client.getFileUrl(f.id, 0)) : undefined}
                                    className={`${compact ? 'max-h-36' : 'max-h-64'} max-w-full rounded-xl object-cover ring-1 ring-line`}
                                />
                            ) : (
                                <span key={f.id} className='rounded-xl bg-tint px-3 py-2 text-[12.5px] text-ink'>{f.name}</span>
                            )),
                        )}
                    </div>
                )}
                {decisionOf(post) && <DecisionCard post={post} compact={compact}/>}
                {!compact && !post.root_id && post.reply_count > 0 && (
                    <div className='mt-1 text-[12px] font-semibold text-accent-text'>{post.reply_count} {post.reply_count === 1 ? 'reply' : 'replies'}</div>
                )}
            </div>
        </div>
    );
}

// Show avatar and name only when the author changes or after a pause.
export function isGrouped(prev: Post | undefined, post: Post): boolean {
    return Boolean(prev && prev.user_id === post.user_id && post.create_at - prev.create_at < 5 * 60 * 1000 && !decisionOf(prev) && !post.root_id && !prev.root_id);
}
