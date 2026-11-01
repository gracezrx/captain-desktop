// Real files from agents, in Captain's look:
// - create_document: a Word file, a PDF copy, and a Google Doc when the
//   asker connected Google Docs;
// - create_presentation: a PowerPoint deck, and Google Slides when connected;
// - create_spreadsheet: an Excel workbook, and a Google Sheet when connected.
// They land in the asker's own Drive, in "Captain › <chat>" when Drive is
// connected. New private files only: nothing is shared or sent, so no
// approval. Each file's card shows its kind, length and the Google copy.

import {storeFile} from '../../app/files.js';
import {canMake, type Google, googleDoc, type GoogleFile, googleFor, googleSheet, googleSlides} from '../../connectors/google-files.js';
import {headingsOf, makeDocx} from '../../files/make/docx.js';
import {readMarkdown, withoutTitle, wordCount} from '../../files/make/markdown.js';
import {makePdf, pdfCanDraw} from '../../files/make/pdf.js';
import {type DeckSpec, makePptx, type SlideSpec} from '../../files/make/pptx.js';
import {fileStem} from '../../files/make/theme.js';
import {type ColumnType, makeXlsx, type SheetSpec} from '../../files/make/xlsx.js';
import type {FileProps} from '../../shared/types.js';
import {updateFileProps} from '../../store/files.js';
import {log} from '../../util/log.js';

import {str, type Tool, type ToolContext} from './types.js';

const MIME = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pdf: 'application/pdf',
};

function byline(tc: ToolContext): string {
    const by = tc.agentUser.displayName || 'Captain';
    const forWhom = tc.requester.isBot ? '' : ` for ${tc.requester.displayName}`;
    return `Prepared by ${by}${forWhom}`;
}

async function store(tc: ToolContext, name: string, mime: string, data: Buffer, props: FileProps) {
    return storeFile(tc.ctx, {workspaceId: tc.channel.workspaceId, channelId: tc.channel.id, userId: tc.agentUser.id, name, mime, data, props});
}

// A Google copy, or why there isn't one (for the agent's own reply).
async function google(make: () => Promise<GoogleFile>, what: string): Promise<{file?: GoogleFile; note: string}> {
    try {
        const file = await make();
        return {file, note: ` Also made it in ${what}: ${file.url}${file.folder ? ` (in the "${file.folder}" folder of their Drive)` : ''}.`};
    } catch (err) {
        log.warn({err: (err as Error).message}, `couldn't make the ${what} copy`);
        return {note: ` (Couldn't make the ${what} copy this time; the attached file is complete.)`};
    }
}

const ATTACHED = 'It is attached to your reply as a file card: don\'t paste its contents into the message; say in a line or two what it covers.';

// --- Documents ---------------------------------------------------------------

export const createDocument: Tool = {
    name: 'create_document',
    description: [
        'Write a document (brief, plan, report, memo, proposal, one-pager, notes) as a polished Word file with a PDF copy, attached to your reply.',
        'If the person connected Google Docs it is also made as a Google Doc in their Drive.',
        'Write the body in Markdown: ## and ### headings, short paragraphs, lists, tables (| a | b |), > for a callout, **bold** for key facts.',
        'Don\'t repeat the title as a heading: the title block shows it. Use it for anything longer than a chat message.',
    ].join(' '),
    parameters: {
        type: 'object',
        properties: {
            title: {type: 'string', description: 'The document\'s title, in a few words'},
            subtitle: {type: 'string', description: 'One line under the title: what it is and who it is for (optional)'},
            markdown: {type: 'string', description: 'The full document body in Markdown'},
        },
        required: ['title', 'markdown'],
    },
    external: false,
    available: () => true,
    activity: (a) => `Writing "${str(a.title, 60) || 'a document'}"`,
    async run(tc, args) {
        const title = str(args.title, 120).trim() || 'Document';
        const subtitle = str(args.subtitle, 200).trim() || undefined;
        const markdown = str(args.markdown, 200_000);
        const body = withoutTitle(readMarkdown(markdown), title);
        const meta = {title, subtitle, byline: byline(tc)};
        const stem = fileStem(title) || 'Document';
        const words = wordCount(body);

        const docx = await store(tc, `${stem}.docx`, MIME.docx, await makeDocx(meta, body), {made: 'document', words});
        const ids = [docx.id];
        let pdfNote = '';
        if (pdfCanDraw(`${title} ${subtitle ?? ''} ${markdown}`)) {
            const pdf = await store(tc, `${stem}.pdf`, MIME.pdf, await makePdf(meta, body), {made: 'document', words, copyOf: docx.id});
            ids.push(pdf.id);
            await updateFileProps(tc.ctx.sql, docx.id, {pdf: pdf.id});
            pdfNote = ' and a PDF copy';
        }

        const g = await googleFor(tc.ctx, tc.requester, tc.channel.workspaceId);
        let googleNote = '';
        if (canMake(g, 'docs')) {
            // The Google Doc opens with its title (and subtitle) like the Word file.
            const lead = markdown.match(/^\s*#\s+(.+)/)?.[1]?.replace(/[*_`]/g, '').trim().toLowerCase();
            const md = lead === title.toLowerCase() ? markdown : `# ${title}\n\n${subtitle ? `_${subtitle}_\n\n` : ''}${markdown}`;
            const made = await google(() => googleDoc(g, tc.channel, title, md), 'Google Docs');
            if (made.file) {
                await updateFileProps(tc.ctx.sql, docx.id, {google: made.file});
            }
            googleNote = made.note;
        }
        const sections = headingsOf(body).slice(0, 8);
        return {
            content: `Created "${stem}.docx" (${words} words${sections.length ? `; sections: ${sections.join(', ')}` : ''})${pdfNote}.${googleNote} ${ATTACHED}`,
            fileIds: ids,
        };
    },
};

// --- Decks -------------------------------------------------------------------

const LAYOUTS = ['title', 'section', 'bullets', 'two_columns', 'stats', 'chart', 'table', 'quote', 'timeline', 'closing'];

const SLIDE_SCHEMA = {
    type: 'object',
    properties: {
        layout: {type: 'string', enum: LAYOUTS, description: 'title: opening slide. section: a divider. bullets: 3-5 points. two_columns: compare two sides. stats: 2-4 big numbers. chart: numbers over time or across things. table: a small grid. quote: one line that matters. timeline: 3-6 steps in order. closing: next steps.'},
        kicker: {type: 'string', description: 'A small label above the title, 1-3 words (e.g. "Q3 results")'},
        title: {type: 'string', description: 'The slide\'s point as a short sentence ("Signups doubled after the launch"), not a topic ("Signups")'},
        subtitle: {type: 'string'},
        bullets: {type: 'array', items: {type: 'string'}, description: '3-5 short points, under 12 words each; **bold** the key fact; indent with two spaces for a sub-point'},
        takeaway: {type: 'string', description: 'The one thing to remember, shown in a gold callout (optional)'},
        left: {type: 'object', properties: {heading: {type: 'string'}, bullets: {type: 'array', items: {type: 'string'}}}},
        right: {type: 'object', properties: {heading: {type: 'string'}, bullets: {type: 'array', items: {type: 'string'}}}},
        stats: {type: 'array', items: {type: 'object', properties: {value: {type: 'string'}, label: {type: 'string'}, note: {type: 'string'}}, required: ['value', 'label']}},
        table: {type: 'object', properties: {columns: {type: 'array', items: {type: 'string'}}, rows: {type: 'array', items: {type: 'array', items: {type: 'string'}}}}},
        chart: {
            type: 'object',
            properties: {
                type: {type: 'string', enum: ['bar', 'hbar', 'line', 'pie', 'doughnut']},
                categories: {type: 'array', items: {type: 'string'}},
                series: {type: 'array', items: {type: 'object', properties: {name: {type: 'string'}, values: {type: 'array', items: {type: 'number'}}}}},
                unit: {type: 'string', description: 'e.g. "$", "%", "users"'},
            },
        },
        quote: {type: 'string'},
        attribution: {type: 'string'},
        steps: {type: 'array', items: {type: 'object', properties: {title: {type: 'string'}, text: {type: 'string'}}, required: ['title']}},
        notes: {type: 'string', description: 'Speaker notes'},
    },
};

function slides(raw: unknown): SlideSpec[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((s) => s && typeof s === 'object').slice(0, 40) as SlideSpec[];
}

// The deck as Markdown for Google Slides: one slide per "---" with its
// headline, points and numbers.
export function deckMarkdown(spec: DeckSpec): string {
    const plain = (s?: string) => (s ?? '').replace(/\*\*/g, '').trim();
    const out: string[] = [];
    for (const sl of spec.slides) {
        const opening = (sl.layout ?? '').toLowerCase() === 'title';
        const lines: string[] = [`# ${plain(sl.title) || (opening ? spec.title : plain(sl.kicker)) || spec.title}`];
        const sub = sl.subtitle ?? (opening ? spec.subtitle : undefined);
        if (sub) {
            lines.push(plain(sub));
        }
        const points: string[] = [];
        points.push(...(sl.bullets ?? []).map((b) => `${/^(\s{2,}|\t)/.test(b) ? '  ' : ''}- ${plain(b.replace(/^\s*[-–•]\s*/, ''))}`));
        for (const col of [sl.left, sl.right]) {
            if (col) {
                points.push(`- **${plain(col.heading) || '—'}**`, ...(col.bullets ?? []).map((b) => `  - ${plain(b)}`));
            }
        }
        points.push(...(sl.stats ?? []).map((st) => `- **${plain(st.value)}** ${plain(st.label)}${st.note ? ` (${plain(st.note)})` : ''}`));
        if (sl.table?.columns?.length) {
            points.push(...(sl.table.rows ?? []).slice(0, 8).map((r) => `- ${sl.table!.columns.map((c, i) => `${plain(c)}: ${plain(String(r[i] ?? ''))}`).join(' · ')}`));
        }
        if (sl.chart?.categories?.length) {
            const series = sl.chart.series ?? [];
            const unit = sl.chart.unit ?? '';
            const show = (v: unknown) => {
                const n = Number(v);
                const text = Number.isFinite(n) ? n.toLocaleString('en-US', {maximumFractionDigits: 2}) : String(v ?? '');
                return unit === '$' ? `$${text}` : unit === '%' ? `${text}%` : unit ? `${text} ${unit}` : text;
            };
            points.push(...sl.chart.categories.slice(0, 10).map((c, i) => `- ${plain(c)}: ${series.map((s) => `${series.length > 1 ? `${s.name} ` : ''}${show(s.values?.[i])}`).join(', ')}`));
        }
        points.push(...(sl.steps ?? []).map((st, i) => `${i + 1}. **${plain(st.title)}**${st.text ? ` ${plain(st.text)}` : ''}`));
        if (sl.quote) {
            points.push(`> ${plain(sl.quote)}${sl.attribution ? ` — ${plain(sl.attribution)}` : ''}`);
        }
        if (sl.takeaway) {
            points.push('', `**${plain(sl.takeaway)}**`);
        }
        out.push([...lines, ...(points.length ? ['', ...points] : [])].join('\n'));
    }
    return out.join('\n\n---\n\n');
}

export const createPresentation: Tool = {
    name: 'create_presentation',
    description: [
        'Make a slide deck as a polished PowerPoint file (native, editable charts and tables) attached to your reply; also made as Google Slides when the person connected it.',
        'Plan the story first: a title slide, 4-12 slides that each make one point, and a closing slide with next steps.',
        'Give every slide a headline that states its point. Prefer stats, charts, tables, timelines and two columns over walls of bullets; use only numbers you actually have.',
    ].join(' '),
    parameters: {
        type: 'object',
        properties: {
            title: {type: 'string', description: 'The deck\'s title'},
            subtitle: {type: 'string', description: 'One line on what it is and who it is for'},
            slides: {type: 'array', items: SLIDE_SCHEMA, description: 'The slides, in order'},
        },
        required: ['title', 'slides'],
    },
    external: false,
    available: () => true,
    activity: (a) => `Making the deck "${str(a.title, 60) || 'Deck'}"`,
    async run(tc, args) {
        const title = str(args.title, 120).trim() || 'Deck';
        const subtitle = str(args.subtitle, 200).trim() || undefined;
        const list = slides(args.slides);
        if (!list.length) {
            return {content: 'No slides were given: pass "slides", a list of slides with a layout and a title each.'};
        }
        const spec: DeckSpec = {title, subtitle, byline: byline(tc), slides: list};
        const {data, slides: count} = await makePptx(spec);
        const stem = fileStem(title) || 'Deck';
        const file = await store(tc, `${stem}.pptx`, MIME.pptx, data, {made: 'presentation', slides: count});

        const g = await googleFor(tc.ctx, tc.requester, tc.channel.workspaceId);
        let googleNote = '';
        if (canMake(g, 'slides')) {
            const made = await google(() => googleSlides(g as Google, tc.channel, title, deckMarkdown(spec)), 'Google Slides');
            if (made.file) {
                await updateFileProps(tc.ctx.sql, file.id, {google: made.file});
            }
            googleNote = made.note;
        }
        return {content: `Created "${stem}.pptx" (${count} slides).${googleNote} ${ATTACHED}`, fileIds: [file.id]};
    },
};

// --- Spreadsheets --------------------------------------------------------------

const TYPES: ColumnType[] = ['text', 'number', 'integer', 'currency', 'percent', 'date'];

function sheetSpecs(raw: unknown): SheetSpec[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((s) => s && typeof s === 'object').slice(0, 20).map((s, i) => {
        const o = s as Record<string, unknown>;
        const columns = (Array.isArray(o.columns) ? o.columns : []).map((c) => {
            const col = (typeof c === 'string' ? {header: c} : c) as Record<string, unknown>;
            const type = TYPES.includes(col.type as ColumnType) ? (col.type as ColumnType) : 'text';
            return {header: str(col.header ?? col.name, 80) || 'Column', type, width: typeof col.width === 'number' ? col.width : undefined};
        });
        const rows = (Array.isArray(o.rows) ? o.rows : []).filter(Array.isArray).map((r) => (r as unknown[]).map((v) => (typeof v === 'number' || typeof v === 'boolean' || v === null ? v : str(v, 2000))));
        return {name: str(o.name, 60) || `Sheet ${i + 1}`, title: str(o.title, 160) || undefined, note: str(o.note, 300) || undefined, columns, rows, totals: o.totals === true};
    }).filter((s) => s.columns.length);
}

export const createSpreadsheet: Tool = {
    name: 'create_spreadsheet',
    description: [
        'Make a spreadsheet (a budget, tracker, list, comparison, model) as a polished Excel file attached to your reply; also made as a Google Sheet when the person connected it.',
        'Give each column a type so numbers are real numbers (currency, percent, integer, number, date, text); put raw numbers in rows, not text like "$1.2k".',
        'Set totals to add a row of SUM formulas under the number columns.',
    ].join(' '),
    parameters: {
        type: 'object',
        properties: {
            title: {type: 'string', description: 'The workbook\'s title'},
            sheets: {
                type: 'array',
                description: 'One or more sheets (tabs)',
                items: {
                    type: 'object',
                    properties: {
                        name: {type: 'string', description: 'The tab name, short'},
                        title: {type: 'string', description: 'A heading above the table'},
                        note: {type: 'string', description: 'One line under the heading: source, date, assumptions'},
                        columns: {type: 'array', items: {type: 'object', properties: {header: {type: 'string'}, type: {type: 'string', enum: TYPES}}, required: ['header']}},
                        rows: {type: 'array', items: {type: 'array', items: {}}, description: 'One array of cell values per row, in column order'},
                        totals: {type: 'boolean'},
                    },
                    required: ['name', 'columns', 'rows'],
                },
            },
        },
        required: ['title', 'sheets'],
    },
    external: false,
    available: () => true,
    activity: (a) => `Building the sheet "${str(a.title, 60) || 'Spreadsheet'}"`,
    async run(tc, args) {
        const title = str(args.title, 120).trim() || 'Spreadsheet';
        const sheets = sheetSpecs(args.sheets);
        if (!sheets.length) {
            return {content: 'No sheets were given: pass "sheets", each with a name, columns and rows.'};
        }
        const {data, sheets: count, rows} = await makeXlsx(title, sheets);
        const stem = fileStem(title) || 'Spreadsheet';
        const file = await store(tc, `${stem}.xlsx`, MIME.xlsx, data, {made: 'spreadsheet', sheets: count, rows});

        const g = await googleFor(tc.ctx, tc.requester, tc.channel.workspaceId);
        let googleNote = '';
        if (canMake(g, 'sheets')) {
            const made = await google(() => googleSheet(g as Google, tc.channel, title, sheets), 'Google Sheets');
            if (made.file) {
                await updateFileProps(tc.ctx.sql, file.id, {google: made.file});
            }
            googleNote = made.note;
        }
        return {content: `Created "${stem}.xlsx" (${count} ${count === 1 ? 'sheet' : 'sheets'}, ${rows} rows).${googleNote} ${ATTACHED}`, fileIds: [file.id]};
    },
};
