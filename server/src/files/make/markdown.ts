// Markdown, read into the few kinds of blocks a Word file or a PDF needs.

import {Lexer, type Token, type Tokens} from 'marked';

export type Inline = {text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; link?: string};

export type ListItem = {inlines: Inline[]; children: Block[]; checked: boolean | null};

export type Block =
    | {kind: 'heading'; level: number; inlines: Inline[]}
    | {kind: 'paragraph'; inlines: Inline[]}
    | {kind: 'list'; ordered: boolean; start: number; items: ListItem[]}
    | {kind: 'table'; header: Inline[][]; rows: Inline[][][]; align: ('left' | 'center' | 'right' | null)[]}
    | {kind: 'quote'; blocks: Block[]}
    | {kind: 'code'; text: string}
    | {kind: 'rule'};

type Style = Omit<Inline, 'text'>;

function decode(s: string): string {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'');
}

export function inlines(tokens: Token[] | undefined, style: Style = {}): Inline[] {
    const out: Inline[] = [];
    for (const t of tokens ?? []) {
        switch (t.type) {
            case 'strong':
                out.push(...inlines((t as Tokens.Strong).tokens, {...style, bold: true}));
                break;
            case 'em':
                out.push(...inlines((t as Tokens.Em).tokens, {...style, italic: true}));
                break;
            case 'del':
                out.push(...inlines((t as Tokens.Del).tokens, {...style, strike: true}));
                break;
            case 'codespan':
                out.push({...style, code: true, text: decode((t as Tokens.Codespan).text)});
                break;
            case 'link': {
                const l = t as Tokens.Link;
                out.push(...inlines(l.tokens, {...style, link: l.href}));
                break;
            }
            case 'br':
                out.push({...style, text: '\n'});
                break;
            case 'html':
                break; // dropped: a document isn't a web page
            case 'text': {
                const tx = t as Tokens.Text;
                if (tx.tokens?.length) {
                    out.push(...inlines(tx.tokens, style));
                } else {
                    out.push({...style, text: decode(tx.text)});
                }
                break;
            }
            default:
                if ('text' in t && typeof t.text === 'string') {
                    out.push({...style, text: decode(t.text)});
                }
        }
    }
    // Neighbours in the same style become one run.
    return out.reduce<Inline[]>((acc, r) => {
        const prev = acc.at(-1);
        if (prev && r.text !== '\n' && prev.text !== '\n' && JSON.stringify({...prev, text: ''}) === JSON.stringify({...r, text: ''})) {
            prev.text += r.text;
        } else {
            acc.push({...r});
        }
        return acc;
    }, []);
}

function blocks(tokens: Token[]): Block[] {
    const out: Block[] = [];
    for (const t of tokens) {
        switch (t.type) {
            case 'heading': {
                const h = t as Tokens.Heading;
                out.push({kind: 'heading', level: Math.min(4, h.depth), inlines: inlines(h.tokens)});
                break;
            }
            case 'paragraph':
                out.push({kind: 'paragraph', inlines: inlines((t as Tokens.Paragraph).tokens)});
                break;
            case 'text': {
                const tx = t as Tokens.Text;
                out.push({kind: 'paragraph', inlines: tx.tokens?.length ? inlines(tx.tokens) : [{text: decode(tx.text)}]});
                break;
            }
            case 'list': {
                const l = t as Tokens.List;
                out.push({
                    kind: 'list', ordered: l.ordered, start: typeof l.start === 'number' ? l.start : 1,
                    items: l.items.map((item) => {
                        const lead: Inline[] = [];
                        const children: Block[] = [];
                        for (const sub of item.tokens) {
                            if ((sub.type === 'text' || sub.type === 'paragraph') && !lead.length) {
                                const s = sub as Tokens.Text;
                                lead.push(...(s.tokens?.length ? inlines(s.tokens) : [{text: decode(s.text)}]));
                            } else if (sub.type !== 'checkbox') {
                                children.push(...blocks([sub]));
                            }
                        }
                        return {inlines: lead, children, checked: item.task ? Boolean(item.checked) : null};
                    }),
                });
                break;
            }
            case 'table': {
                const tb = t as Tokens.Table;
                out.push({
                    kind: 'table',
                    header: tb.header.map((c) => inlines(c.tokens)),
                    rows: tb.rows.map((r) => r.map((c) => inlines(c.tokens))),
                    align: tb.align,
                });
                break;
            }
            case 'blockquote':
                out.push({kind: 'quote', blocks: blocks((t as Tokens.Blockquote).tokens)});
                break;
            case 'code':
                out.push({kind: 'code', text: (t as Tokens.Code).text});
                break;
            case 'hr':
                out.push({kind: 'rule'});
                break;
            default:
                break; // space, html, definitions
        }
    }
    return out;
}

export function readMarkdown(markdown: string): Block[] {
    return blocks(new Lexer({gfm: true}).lex(markdown.replace(/\r\n?/g, '\n')));
}

export function plainText(runs: Inline[]): string {
    return runs.map((r) => r.text).join('');
}

// A leading "# Title" that repeats the document's own title is dropped: the
// title block already shows it.
export function withoutTitle(list: Block[], title: string): Block[] {
    const first = list[0];
    if (first?.kind === 'heading' && first.level === 1 && plainText(first.inlines).trim().toLowerCase() === title.trim().toLowerCase()) {
        return list.slice(1);
    }
    return list;
}

export function wordCount(list: Block[]): number {
    let n = 0;
    const count = (s: string) => {
        n += (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
    };
    const walk = (bs: Block[]) => {
        for (const b of bs) {
            if (b.kind === 'heading' || b.kind === 'paragraph') {
                count(plainText(b.inlines));
            } else if (b.kind === 'list') {
                b.items.forEach((i) => {
                    count(plainText(i.inlines));
                    walk(i.children);
                });
            } else if (b.kind === 'table') {
                [b.header, ...b.rows].forEach((r) => r.forEach((c) => count(plainText(c))));
            } else if (b.kind === 'quote') {
                walk(b.blocks);
            } else if (b.kind === 'code') {
                count(b.text);
            }
        }
    };
    walk(list);
    return n;
}
