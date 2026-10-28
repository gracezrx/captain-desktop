import {X} from 'lucide-react';
import {type ReactNode, useEffect} from 'react';

export function Modal({title, onClose, children, width = 460}: {title: string; onClose: () => void; children: ReactNode; width?: number}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className='fixed inset-0 z-40 grid place-items-center bg-[rgba(20,39,105,0.18)] p-6 backdrop-blur-[2px]' onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div role='dialog' aria-label={title} className='flex max-h-full w-full flex-col overflow-hidden rounded-3xl bg-surface ring-1 ring-line' style={{maxWidth: width, boxShadow: 'var(--shadow-overlay)'}}>
                <div className='flex items-center gap-2 px-5 pt-4 pb-2'>
                    <h2 className='flex-1 text-[16px] font-extrabold tracking-tight text-ink'>{title}</h2>
                    <button type='button' aria-label='Close' onClick={onClose} className='grid size-8 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'><X size={16}/></button>
                </div>
                <div className='scroll-quiet min-h-0 overflow-y-auto px-5 pb-5'>{children}</div>
            </div>
        </div>
    );
}

export const input = 'h-10 w-full rounded-xl bg-bg-subtle px-3 text-[13.5px] text-ink ring-1 ring-line outline-none placeholder:text-muted focus:ring-2 focus:ring-accent';
export const primaryBtn = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-bold text-on-accent transition-opacity disabled:opacity-50';
export const ghostBtn = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold text-text ring-1 ring-line hover:bg-tint disabled:opacity-50';

export function FieldLabel({text, hint, children}: {text: string; hint?: string; children: ReactNode}) {
    return (
        <label className='block'>
            <span className='mb-1 block text-[12px] font-bold text-muted'>{text}</span>
            {children}
            {hint && <span className='mt-1 block text-[11.5px] text-muted'>{hint}</span>}
        </label>
    );
}
