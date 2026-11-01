// A Word document from Markdown, in Captain's look: a title block with a
// gold rule, navy headings, tables with a navy header row and light banding,
// and page numbers.

import {
    AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, LevelFormat, Packer, PageNumber,
    Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';

import {type Block, type Inline, plainText} from './markdown.js';
import {BRAND, FONT} from './theme.js';

export type DocMeta = {title: string; subtitle?: string; byline: string};

const pt = (n: number) => Math.round(n * 2); // docx sizes are half-points

function runs(list: Inline[], base: {color?: string; size?: number; bold?: boolean; italics?: boolean} = {}): (TextRun | ExternalHyperlink)[] {
    return list.map((r) => {
        const t = new TextRun({
            text: r.text === '\n' ? '' : r.text,
            break: r.text === '\n' ? 1 : undefined,
            bold: r.bold || base.bold,
            italics: r.italic || base.italics,
            strike: r.strike,
            font: r.code ? FONT.mono : undefined,
            size: r.code ? pt(9.5) : base.size,
            color: r.link ? BRAND.deep : base.color,
            underline: r.link ? {} : undefined,
            shading: r.code ? {type: ShadingType.CLEAR, color: 'auto', fill: BRAND.subtle} : undefined,
        });
        return r.link && /^(https?:|mailto:)/i.test(r.link) ? new ExternalHyperlink({link: r.link, children: [t]}) : t;
    });
}

function cell(content: Inline[], header: boolean, band: boolean, align: 'left' | 'center' | 'right' | null): TableCell {
    return new TableCell({
        shading: header ? {type: ShadingType.CLEAR, color: 'auto', fill: BRAND.navy} : band ? {type: ShadingType.CLEAR, color: 'auto', fill: BRAND.tint} : undefined,
        margins: {top: 90, bottom: 90, left: 140, right: 140},
        children: [new Paragraph({
            alignment: align === 'right' ? AlignmentType.RIGHT : align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
            spacing: {before: 0, after: 0},
            children: runs(content, header ? {color: BRAND.white, bold: true, size: pt(10)} : {size: pt(10)}),
        })],
    });
}

const line = {style: BorderStyle.SINGLE, size: 4, color: BRAND.line};

function render(list: Block[], out: (Paragraph | Table)[], state: {lists: number}, depth = 0): void {
    for (const b of list) {
        switch (b.kind) {
            case 'heading': {
                const level = Math.min(3, b.level);
                out.push(new Paragraph({style: `Heading${level}`, children: runs(b.inlines), keepNext: true}));
                break;
            }
            case 'paragraph':
                out.push(new Paragraph({children: runs(b.inlines)}));
                break;
            case 'list': {
                const instance = ++state.lists;
                for (const item of b.items) {
                    const box = item.checked === null ? [] : [new TextRun({text: item.checked ? '\u2713 ' : '\u25A1 ', color: BRAND.royal, bold: true})];
                    out.push(new Paragraph({
                        numbering: {reference: b.ordered ? 'numbers' : 'bullets', level: Math.min(depth, 2), instance: b.ordered ? instance : undefined},
                        spacing: {after: 60},
                        children: [...box, ...runs(item.inlines)],
                    }));
                    render(item.children, out, state, depth + 1);
                }
                break;
            }
            case 'table': {
                const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length));
                out.push(new Table({
                    width: {size: 100, type: WidthType.PERCENTAGE},
                    borders: {top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: {style: BorderStyle.NONE, size: 0, color: 'auto'}},
                    rows: [
                        new TableRow({tableHeader: true, children: Array.from({length: cols}, (_, i) => cell(b.header[i] ?? [], true, false, b.align[i] ?? null))}),
                        ...b.rows.map((r, ri) => new TableRow({children: Array.from({length: cols}, (_, i) => cell(r[i] ?? [], false, ri % 2 === 1, b.align[i] ?? null))})),
                    ],
                }));
                out.push(new Paragraph({spacing: {after: 120}, children: []}));
                break;
            }
            case 'quote':
                // An indented aside with a gold rule; anything else inside it as usual.
                for (const q of b.blocks) {
                    if (q.kind === 'paragraph' || q.kind === 'heading') {
                        out.push(new Paragraph({
                            indent: {left: 360},
                            border: {left: {style: BorderStyle.SINGLE, size: 18, color: BRAND.gold, space: 12}},
                            spacing: {before: 80, after: 80},
                            children: runs(q.inlines, {italics: true, color: BRAND.text}),
                        }));
                    } else {
                        render([q], out, state, depth);
                    }
                }
                break;
            case 'code':
                for (const l of b.text.split('\n')) {
                    out.push(new Paragraph({
                        spacing: {before: 0, after: 0},
                        shading: {type: ShadingType.CLEAR, color: 'auto', fill: BRAND.subtle},
                        indent: {left: 120, right: 120},
                        children: [new TextRun({text: l || ' ', font: FONT.mono, size: pt(9)})],
                    }));
                }
                out.push(new Paragraph({spacing: {after: 120}, children: []}));
                break;
            case 'rule':
                out.push(new Paragraph({border: {bottom: {style: BorderStyle.SINGLE, size: 6, color: BRAND.line, space: 4}}, spacing: {after: 200}, children: []}));
                break;
        }
    }
}

function bulletLevels(ordered: boolean) {
    return [0, 1, 2].map((level) => ({
        level,
        format: ordered ? [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level] : LevelFormat.BULLET,
        text: ordered ? `%${level + 1}.` : ['•', '–', '·'][level],
        alignment: AlignmentType.LEFT,
        style: {
            paragraph: {indent: {left: 360 + level * 360, hanging: 280}},
            run: {color: BRAND.royal, bold: ordered},
        },
    }));
}

export async function makeDocx(meta: DocMeta, body: Block[]): Promise<Buffer> {
    const children: (Paragraph | Table)[] = [
        new Paragraph({spacing: {after: 80}, children: [new TextRun({text: meta.title, font: FONT.head, bold: true, size: pt(28), color: BRAND.navy})]}),
        ...(meta.subtitle ? [new Paragraph({spacing: {after: 80}, children: [new TextRun({text: meta.subtitle, size: pt(13), color: BRAND.muted})]})] : []),
        new Paragraph({
            spacing: {after: 360},
            border: {bottom: {style: BorderStyle.SINGLE, size: 18, color: BRAND.gold, space: 10}},
            children: [new TextRun({text: meta.byline, size: pt(9.5), color: BRAND.muted})],
        }),
    ];
    render(body, children, {lists: 0});

    const doc = new Document({
        creator: 'Captain',
        title: meta.title,
        description: meta.subtitle,
        styles: {
            default: {
                document: {run: {font: FONT.body, size: pt(11), color: BRAND.text}, paragraph: {spacing: {after: 140, line: 300}}},
                hyperlink: {run: {color: BRAND.deep, underline: {}}},
            },
            paragraphStyles: [
                {id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: {font: FONT.head, bold: true, size: pt(17), color: BRAND.navy}, paragraph: {spacing: {before: 360, after: 120}}},
                {id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: {font: FONT.head, bold: true, size: pt(13.5), color: BRAND.deep}, paragraph: {spacing: {before: 280, after: 100}}},
                {id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: {font: FONT.head, bold: true, size: pt(11.5), color: BRAND.navy}, paragraph: {spacing: {before: 220, after: 80}}},
            ],
        },
        numbering: {config: [{reference: 'bullets', levels: bulletLevels(false)}, {reference: 'numbers', levels: bulletLevels(true)}]},
        sections: [{
            properties: {page: {margin: {top: 1300, bottom: 1300, left: 1350, right: 1350}}},
            headers: {default: new Header({children: [new Paragraph({alignment: AlignmentType.RIGHT, children: [new TextRun({text: meta.title, size: pt(8.5), color: BRAND.muted})]})]})},
            footers: {default: new Footer({children: [new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: pt(8.5), color: BRAND.muted})],
            })]})},
            children,
        }],
    });
    return Packer.toBuffer(doc);
}

export function headingsOf(list: Block[]): string[] {
    return list.filter((b): b is Extract<Block, {kind: 'heading'}> => b.kind === 'heading').map((b) => plainText(b.inlines));
}
