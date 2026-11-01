// A PDF from Markdown, in the same look as the Word file. Drawn with the
// standard PDF fonts, so it covers Latin scripts; a document in another
// script (Chinese, say) gets no PDF and keeps its Word file.

import PDFDocument from 'pdfkit';

import {type Block, type Inline, plainText} from './markdown.js';
import {BRAND} from './theme.js';
import type {DocMeta} from './docx.js';

const hex = (c: string) => `#${c}`;

// Characters the standard fonts can draw (Windows-1252).
const DRAWABLE = /[^\t\n\x20-\x7e\xa0-\xff–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜]/gu;

export function pdfCanDraw(text: string): boolean {
    const odd = (text.replace(/\p{Extended_Pictographic}|️|‍/gu, '').match(DRAWABLE) ?? []).length;
    return odd <= Math.max(3, text.length * 0.01);
}

function clean(s: string): string {
    return s.replace(/\p{Extended_Pictographic}|️|‍/gu, '').replace(/[☐☑☒]/g, '').replace(DRAWABLE, '').replace(/ {2,}/g, ' ');
}

export async function makePdf(meta: DocMeta, body: Block[]): Promise<Buffer> {
    const doc = new PDFDocument({size: 'LETTER', margins: {top: 72, bottom: 72, left: 68, right: 68}, bufferPages: true, info: {Title: meta.title, Author: 'Captain', Creator: 'Captain'}});
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const room = (h: number) => {
        if (doc.y + h > bottom()) {
            doc.addPage();
        }
    };

    const fontFor = (r: Inline) => (r.code ? 'Courier' : r.bold && r.italic ? 'Helvetica-BoldOblique' : r.bold ? 'Helvetica-Bold' : r.italic ? 'Helvetica-Oblique' : 'Helvetica');

    const write = (list: Inline[], o: {x: number; w: number; size: number; color: string; bold?: boolean; italic?: boolean; gap?: number}) => {
        const items = list.filter((r) => clean(r.text).length || r.text === '\n');
        if (!items.length) {
            return;
        }
        items.forEach((r, i) => {
            const run = {...r, bold: r.bold || o.bold, italic: r.italic || o.italic};
            doc.font(fontFor(run)).fontSize(r.code ? o.size - 1 : o.size).fillColor(hex(r.link ? BRAND.deep : o.color));
            const opts = {continued: i < items.length - 1, link: r.link && /^(https?:|mailto:)/i.test(r.link) ? r.link : undefined, underline: Boolean(r.link), lineGap: o.gap ?? 3, width: o.w};
            const text = r.text === '\n' ? '\n' : clean(r.text);
            if (i === 0) {
                doc.text(text, o.x, doc.y, opts);
            } else {
                doc.text(text, opts);
            }
        });
    };

    // The title block.
    doc.font('Helvetica-Bold').fontSize(24).fillColor(hex(BRAND.navy)).text(clean(meta.title), left, doc.y, {width});
    if (meta.subtitle) {
        doc.moveDown(0.2).font('Helvetica').fontSize(12.5).fillColor(hex(BRAND.muted)).text(clean(meta.subtitle), {width});
    }
    doc.moveDown(0.35).font('Helvetica').fontSize(9).fillColor(hex(BRAND.muted)).text(clean(meta.byline), {width});
    doc.moveDown(0.5);
    doc.save().rect(left, doc.y, width, 1.6).fill(hex(BRAND.gold)).restore();
    doc.moveDown(1.4);

    const blocks = (list: Block[], x: number, w: number, depth = 0) => {
        for (const b of list) {
            switch (b.kind) {
                case 'heading': {
                    const size = [0, 16, 13, 11.5, 11][b.level] ?? 11;
                    room(size * 3);
                    doc.moveDown(b.level === 1 ? 0.6 : 0.4);
                    write(b.inlines, {x, w, size, color: b.level === 2 ? BRAND.deep : BRAND.navy, bold: true, gap: 2});
                    doc.moveDown(0.35);
                    break;
                }
                case 'paragraph':
                    room(30);
                    write(b.inlines, {x, w, size: 10.5, color: BRAND.text});
                    doc.moveDown(0.6);
                    break;
                case 'list':
                    b.items.forEach((item, i) => {
                        room(24);
                        const y = doc.y;
                        const mark = item.checked !== null ? (item.checked ? '[x]' : '[ ]') : b.ordered ? `${b.start + i}.` : depth ? '–' : '•';
                        doc.font(b.ordered ? 'Helvetica-Bold' : 'Helvetica-Bold').fontSize(10.5).fillColor(hex(BRAND.royal)).text(mark, x + depth * 14, y, {width: 22, lineBreak: false});
                        doc.y = y;
                        write(item.inlines.length ? item.inlines : [{text: ' '}], {x: x + depth * 14 + 18, w: w - depth * 14 - 18, size: 10.5, color: BRAND.text});
                        doc.moveDown(0.25);
                        blocks(item.children, x, w, depth + 1);
                    });
                    doc.moveDown(0.4);
                    break;
                case 'table': {
                    const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length));
                    const lens = Array.from({length: cols}, (_, c) => Math.max(4, ...[b.header, ...b.rows].map((r) => Math.min(40, plainText(r[c] ?? []).length))));
                    const total = lens.reduce((a, v) => a + v, 0);
                    const widths = lens.map((l) => (l / total) * w);
                    const pad = 6;
                    const row = (cells: Inline[][], header: boolean, band: boolean) => {
                        const size = header ? 9 : 9.5;
                        const heights = widths.map((cw, c) => {
                            doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
                            return doc.heightOfString(clean(plainText(cells[c] ?? [])) || ' ', {width: cw - pad * 2});
                        });
                        const h = Math.max(...heights) + pad * 2;
                        room(h + 4);
                        const y = doc.y;
                        if (header || band) {
                            doc.save().rect(x, y, w, h).fill(hex(header ? BRAND.navy : BRAND.tint)).restore();
                        }
                        let cx = x;
                        widths.forEach((cw, c) => {
                            doc.y = y + pad;
                            write(cells[c]?.length ? cells[c] : [{text: ' '}], {x: cx + pad, w: cw - pad * 2, size, color: header ? BRAND.white : BRAND.text, bold: header, gap: 1});
                            cx += cw;
                        });
                        doc.save().moveTo(x, y + h).lineTo(x + w, y + h).lineWidth(0.5).strokeColor(hex(BRAND.line)).stroke().restore();
                        doc.y = y + h;
                    };
                    row(b.header, true, false);
                    b.rows.forEach((r, i) => row(r, false, i % 2 === 1));
                    doc.x = x;
                    doc.moveDown(1);
                    break;
                }
                case 'quote': {
                    const y0 = doc.y;
                    blocks(b.blocks.map((q) => (q.kind === 'paragraph' ? {...q, inlines: q.inlines.map((r) => ({...r, italic: true}))} : q)), x + 16, w - 16, depth);
                    doc.save().rect(x + 2, y0, 2.4, Math.max(12, doc.y - y0 - 6)).fill(hex(BRAND.gold)).restore();
                    break;
                }
                case 'code': {
                    const text = b.text.split('\n').map(clean).join('\n') || ' ';
                    doc.font('Courier').fontSize(9);
                    const h = doc.heightOfString(text, {width: w - 16}) + 12;
                    room(Math.min(h, 200));
                    const y = doc.y;
                    doc.save().rect(x, y, w, h).fill(hex(BRAND.subtle)).restore();
                    doc.fillColor(hex(BRAND.text)).text(text, x + 8, y + 6, {width: w - 16});
                    doc.y = y + h;
                    doc.moveDown(0.7);
                    break;
                }
                case 'rule':
                    room(20);
                    doc.save().moveTo(x, doc.y + 4).lineTo(x + w, doc.y + 4).lineWidth(0.6).strokeColor(hex(BRAND.line)).stroke().restore();
                    doc.moveDown(1);
                    break;
            }
        }
    };
    blocks(body, left, width);

    // Running title and page numbers.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const keep = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(8).fillColor(hex(BRAND.muted));
        if (i > 0) {
            doc.text(clean(meta.title), left, 36, {width, align: 'right', lineBreak: false});
        }
        doc.text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 44, {width, align: 'right', lineBreak: false});
        doc.page.margins.bottom = keep;
    }
    doc.end();
    return done;
}
