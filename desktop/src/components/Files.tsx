import {FileText} from 'lucide-react';

import {fileUrl} from '../lib/api';
import type {FileInfo} from '../lib/types';

function size(n: number): string {
    return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Attachments: pictures inline, everything else as a card that downloads.
export function Files({files, compact = false, onOpenImage}: {files: FileInfo[]; compact?: boolean; onOpenImage?: (url: string) => void}) {
    if (!files.length) {
        return null;
    }
    return (
        <div className='mt-1.5 flex flex-wrap gap-2'>
            {files.map((f) => (f.mime.startsWith('image/') ? (
                <button key={f.id} type='button' onClick={() => onOpenImage?.(fileUrl(f))} className='block' title={f.name}>
                    <img
                        src={fileUrl(f)}
                        alt={f.name}
                        loading='lazy'
                        className={`${compact ? 'max-h-36' : 'max-h-64'} max-w-full rounded-xl object-cover ring-1 ring-line`}
                        style={f.width && f.height ? {aspectRatio: `${f.width} / ${f.height}`} : undefined}
                        draggable={false}
                    />
                </button>
            ) : (
                <a key={f.id} href={fileUrl(f, true)} target='_blank' rel='noreferrer' className='flex max-w-72 items-center gap-2.5 rounded-xl bg-surface px-3 py-2 ring-1 ring-line hover:bg-tint'>
                    <span className='grid size-8 shrink-0 place-items-center rounded-lg bg-tint text-accent-text'><FileText size={16}/></span>
                    <span className='min-w-0'>
                        <span className='block truncate text-[12.5px] font-semibold text-ink'>{f.name}</span>
                        <span className='block text-[11px] text-muted'>{size(f.size)}</span>
                    </span>
                </a>
            )))}
        </div>
    );
}
