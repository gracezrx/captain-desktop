import {Fragment, type ReactNode} from 'react';

// A small, safe Markdown renderer for messages: headings, lists, quotes,
// code blocks, tables, rules, **bold**, *italic*, `code`, links and
// @mentions. It builds React elements; no HTML from a message is injected.

type Block =
    | {kind: 'p'; lines: string[]}
    | {kind: 'h'; level: number; text: string}
    | {kind: 'ul' | 'ol'; items: string[]}
    | {kind: 'quote'; lines: string[]}
    | {kind: 'code'; lang: string; text: string}
    | {kind: 'table'; head: string[]; rows: string[][]}
    | {kind: 'hr'};

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function parse(text: string): Block[] {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
        if (fence) {
            const body: string[] = [];
            i++;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
                body.push(lines[i++]);
            }
            i++;
            out.push({kind: 'code', lang: fence[1], text: body.join('\n')});
            continue;
        }
        if (!line.trim()) {
            i++;
            continue;
        }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
            out.push({kind: 'h', level: h[1].length, text: h[2]});
            i++;
            continue;
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            out.push({kind: 'hr'});
            i++;
            continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
            const head = cells(line);
            const rows: string[][] = [];
            i += 2;
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
                rows.push(cells(lines[i++]));
            }
            out.push({kind: 'table', head, rows});
            continue;
        }
        if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
            const ordered = /^\s*\d+[.)]\s+/.test(line);
            const items: string[] = [];
            while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i])) {
                let item = lines[i++].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '');
                // Indented continuation lines belong to the item.
                while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i])) {
                    item += `\n${lines[i++].trim()}`;
                }
                items.push(item);
            }
            out.push({kind: ordered ? 'ol' : 'ul', items});
            continue;
        }
        if (/^\s*>/.test(line)) {
            const q: string[] = [];
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                q.push(lines[i++].replace(/^\s*>\s?/, ''));
            }
            out.push({kind: 'quote', lines: q});
            continue;
        }
        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^\s*```|^\s*[-*•]\s+|^\s*\d+[.)]\s+|^\s*>/.test(lines[i])) {
            para.push(lines[i++]);
        }
        if (!para.length) {
            para.push(lines[i++]);
        }
        out.push({kind: 'p', lines: para});
    }
    return out;
}

const TOKEN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+[^\s<.,;:!?\]'"]|@[a-z0-9][a-z0-9._-]*)/gi;

// A link's end: not the punctuation after it, nor the ")" closing the
// parentheses it was written in (its own stay: …/wiki/Slack_(software)).
export function trimLink(raw: string): string {
    let s = raw;
    for (;;) {
        const t = s.replace(/[.,;:!?]+$/, '');
        const opens = (t.match(/\(/g) ?? []).length;
        const closes = (t.match(/\)/g) ?? []).length;
        const next = t.endsWith(')') && closes > opens ? t.slice(0, -1) : t;
        if (next === s) {
            return s;
        }
        s = next;
    }
}

function inline(text: string, me?: string, key = ''): ReactNode[] {
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
        const t = m[0];
        const at = m.index ?? 0;
        if (at > last) {
            out.push(text.slice(last, at));
        }
        const k = `${key}-${at}`;
        // Underscores inside a word (tool_call_id, snake_case) aren't emphasis.
        const inWord = t.startsWith('_') && (/\w/.test(text[at - 1] ?? '') || /\w/.test(text[at + t.length] ?? ''));
        if (inWord) {
            out.push(t);
        } else if (t.startsWith('**') || t.startsWith('__')) {
            out.push(<strong key={k} className='font-bold text-ink'>{inline(t.slice(2, -2), me, k)}</strong>);
        } else if ((t.startsWith('*') || t.startsWith('_')) && t.length > 2) {
            out.push(<em key={k}>{inline(t.slice(1, -1), me, k)}</em>);
        } else if (t.startsWith('`')) {
            out.push(<code key={k} className='rounded-md bg-tint px-1 py-px font-mono text-[0.9em]'>{t.slice(1, -1)}</code>);
        } else if (t.startsWith('[')) {
            const [, label, href] = t.match(/^\[([^\]]+)\]\((.+)\)$/) ?? [];
            out.push(<a key={k} href={href} target='_blank' rel='noreferrer' className='font-medium text-accent-text underline decoration-1 underline-offset-2'>{label}</a>);
        } else if (t.startsWith('@')) {
            // Part of an email address (qa@example.com) isn't a mention; nor is
            // a full stop after one ("ask @writer.").
            if (at > 0 && /[\w.+-]/.test(text[at - 1])) {
                out.push(t);
            } else {
                const handle = t.replace(/[._-]+$/, '');
                const self = me && handle.slice(1).toLowerCase() === me.toLowerCase();
                out.push(<span key={k} className={`rounded px-0.5 font-semibold ${self ? 'bg-gold-tint text-gold-text' : 'text-accent-text'}`}>{handle}</span>);
                if (handle.length < t.length) {
                    out.push(t.slice(handle.length));
                }
            }
        } else {
            const href = trimLink(t);
            out.push(<a key={k} href={href} target='_blank' rel='noreferrer' className='break-all text-accent-text underline decoration-1 underline-offset-2'>{href}</a>);
            if (href.length < t.length) {
                out.push(t.slice(href.length));
            }
        }
        last = at + t.length;
    }
    if (last < text.length) {
        out.push(text.slice(last));
    }
    return out;
}

function lines(list: string[], me?: string, key = ''): ReactNode {
    return list.map((l, i) => (
        <Fragment key={i}>
            {i > 0 && <br/>}
            {inline(l, me, `${key}${i}`)}
        </Fragment>
    ));
}

export function Markup({text, meUsername}: {text: string; meUsername?: string}) {
    const blocks = parse(text);
    return (
        <div className='space-y-2'>
            {blocks.map((b, i) => {
                switch (b.kind) {
                case 'h':
                    return <div key={i} className={`font-extrabold tracking-tight text-ink ${b.level <= 2 ? 'text-[1.08em]' : 'text-[1em]'}`}>{inline(b.text, meUsername, `h${i}`)}</div>;
                case 'ul':
                case 'ol': {
                    const List = b.kind === 'ul' ? 'ul' : 'ol';
                    return (
                        <List key={i} className={`space-y-0.5 pl-5 ${b.kind === 'ul' ? 'list-disc' : 'list-decimal'} marker:text-muted`}>
                            {b.items.map((item, j) => <li key={j}>{lines(item.split('\n'), meUsername, `l${i}.${j}`)}</li>)}
                        </List>
                    );
                }
                case 'quote':
                    return <blockquote key={i} className='border-l-2 border-line pl-3 text-muted'>{lines(b.lines, meUsername, `q${i}`)}</blockquote>;
                case 'code':
                    return <pre key={i} className='scroll-quiet overflow-x-auto rounded-xl bg-tint px-3 py-2 font-mono text-[12.5px] leading-relaxed'><code>{b.text}</code></pre>;
                case 'table':
                    return (
                        <div key={i} className='scroll-quiet overflow-x-auto'>
                            <table className='text-[0.93em]'>
                                <thead><tr>{b.head.map((c, j) => <th key={j} className='border-b border-line px-2 py-1 text-left font-bold text-ink'>{inline(c, meUsername)}</th>)}</tr></thead>
                                <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} className='border-b border-line/60 px-2 py-1 align-top'>{inline(c, meUsername)}</td>)}</tr>)}</tbody>
                            </table>
                        </div>
                    );
                case 'hr':
                    return <hr key={i} className='border-line'/>;
                default:
                    return <p key={i}>{lines(b.lines, meUsername, `p${i}`)}</p>;
                }
            })}
        </div>
    );
}

// Plain text for previews (banners, inbox lines).
export function plain(text: string): string {
    return text.
        replace(/```[\s\S]*?```/g, '[code]').
        replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').
        replace(/(\*\*|__)(.+?)\1/g, '$2').
        replace(/(^|\s)[*_]([^*_\s][^*_\n]*?)[*_](?=\s|$|[.,!?;:])/g, '$1$2').
        replace(/`/g, '').
        replace(/^\s*(#{1,6}|>|[-*•]|\d+[.)])\s+/gm, '').
        replace(/\|/g, ' ').
        replace(/\s+/g, ' ').
        trim();
}
