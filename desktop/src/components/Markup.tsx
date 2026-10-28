import {Fragment, type ReactNode} from 'react';

// A deliberately small message formatter: **bold**, `code`, links,
// @mentions and line breaks. No HTML is ever injected.
const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]|@[a-z0-9._-]+)/gi;

export function Markup({text, meUsername}: {text: string; meUsername?: string}) {
    const lines = text.split('\n');
    return (
        <>
            {lines.map((line, i) => (
                <Fragment key={i}>
                    {i > 0 && <br/>}
                    {formatLine(line, meUsername)}
                </Fragment>
            ))}
        </>
    );
}

function formatLine(line: string, me?: string): ReactNode[] {
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of line.matchAll(TOKEN)) {
        const t = m[0];
        const at = m.index ?? 0;
        if (at > last) {
            out.push(line.slice(last, at));
        }
        if (t.startsWith('**')) {
            out.push(<strong key={at} className='font-semibold text-ink'>{t.slice(2, -2)}</strong>);
        } else if (t.startsWith('`')) {
            out.push(<code key={at} className='rounded bg-tint px-1 py-px font-mono text-[0.92em]'>{t.slice(1, -1)}</code>);
        } else if (t.startsWith('@')) {
            const self = me && t.slice(1).toLowerCase() === me.toLowerCase();
            out.push(
                <span key={at} className={`rounded px-0.5 font-semibold ${self ? 'bg-gold-tint text-gold-text' : 'text-accent-text'}`}>{t}</span>,
            );
        } else {
            out.push(<a key={at} href={t} target='_blank' rel='noreferrer' className='text-accent-text underline decoration-1 underline-offset-2'>{t}</a>);
        }
        last = at + t.length;
    }
    if (last < line.length) {
        out.push(line.slice(last));
    }
    return out;
}
