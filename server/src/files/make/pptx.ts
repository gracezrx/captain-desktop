// A PowerPoint deck from a slide outline, in Captain's look: navy title and
// closing slides, a headline and a short blue rule on every content slide,
// stat cards, native charts (editable in PowerPoint), banded tables, and a
// gold callout for the one thing to remember.

import JSZip from 'jszip';
import pptxgenjs from 'pptxgenjs';

import {BRAND, FONT, SERIES, today} from './theme.js';

export type SlideSpec = {
    layout?: string;
    kicker?: string; // a small label above the title
    title?: string;
    subtitle?: string;
    bullets?: string[];
    takeaway?: string;
    left?: {heading?: string; bullets?: string[]};
    right?: {heading?: string; bullets?: string[]};
    stats?: {value: string; label: string; note?: string}[];
    table?: {columns: string[]; rows: string[][]};
    chart?: {type?: string; categories: string[]; series: {name: string; values: number[]}[]; unit?: string};
    quote?: string;
    attribution?: string;
    steps?: {title: string; text?: string}[];
    notes?: string;
};

export type DeckSpec = {title: string; subtitle?: string; byline: string; slides: SlideSpec[]};

// pptxgenjs is CommonJS with ES-style typings: take the class wherever it is.
type PptxClass = typeof import('pptxgenjs').default;
const PptxGenJS = ((pptxgenjs as unknown as {default?: PptxClass}).default ?? pptxgenjs) as unknown as PptxClass;
type Slide = ReturnType<InstanceType<PptxClass>['addSlide']>;

const W = 13.333;
const X0 = 0.75;
const CW = W - X0 * 2;

type Run = {text: string; options?: Record<string, unknown>};

// "**words**" in slide text become bold.
function rich(s: string, base: Record<string, unknown> = {}): Run[] {
    const parts = String(s ?? '').split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    if (!parts.length) {
        return [{text: '', options: {...base}}];
    }
    return parts.map((p) => (p.startsWith('**') && p.endsWith('**') ? {text: p.slice(2, -2), options: {...base, bold: true}} : {text: p.replace(/\*\*/g, ''), options: {...base}}));
}

function bulletRuns(items: string[], size: number, color: string): Run[] {
    const out: Run[] = [];
    items.forEach((item) => {
        const raw = String(item ?? '');
        const sub = /^(\s{2,}|\t)/.test(raw) ? 1 : 0; // indented: a sub-point
        const text = raw.replace(/^\s*[-–•]\s*/, '').trim();
        const runs = rich(text || ' ', {fontSize: sub ? size - 3 : size, color});
        // The paragraph's settings ride on its first run (pptxgenjs starts a new
        // paragraph at every run that carries a bullet).
        runs[0].options = {...runs[0].options, bullet: {code: sub ? '2013' : '25A0', indent: 22}, indentLevel: sub, paraSpaceAfter: 10};
        runs[runs.length - 1].options = {...runs[runs.length - 1].options, breakLine: true};
        out.push(...runs);
    });
    return out;
}

// pptxgenjs writes paragraph settings before every run of a paragraph, and a
// later run's "no bullet" then wins over the first run's bullet (and some
// apps call the file damaged). Keep only each paragraph's first settings.
async function tidy(data: Buffer): Promise<Buffer> {
    const zip = await JSZip.loadAsync(data);
    const names = Object.keys(zip.files).filter((n) => /^ppt\/(slides|notesSlides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(n));
    for (const name of names) {
        const xml = await zip.file(name)!.async('string');
        const fixed = xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_, inner: string) => {
            let seen = false;
            return `<a:p>${inner.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (m) => (seen ? '' : ((seen = true), m)))}</a:p>`;
        });
        if (fixed !== xml) {
            zip.file(name, fixed);
        }
    }
    return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
}

// A model's slide, made safe to draw: text where text goes, lists where
// lists go, numbers in charts.
function tidySlide(raw: SlideSpec): SlideSpec {
    const o = (raw ?? {}) as Record<string, unknown>;
    const t = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));
    const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => t(x) ?? '') : typeof v === 'string' ? v.split('\n').filter(Boolean) : undefined);
    const col = (v: unknown) => (v && typeof v === 'object' ? {heading: t((v as Record<string, unknown>).heading), bullets: list((v as Record<string, unknown>).bullets)} : undefined);
    const objs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[] : []);
    const chart = o.chart && typeof o.chart === 'object' ? o.chart as Record<string, unknown> : null;
    const table = o.table && typeof o.table === 'object' ? o.table as Record<string, unknown> : null;
    return {
        layout: t(o.layout), kicker: t(o.kicker), title: t(o.title), subtitle: t(o.subtitle),
        bullets: list(o.bullets), takeaway: t(o.takeaway), left: col(o.left), right: col(o.right),
        stats: o.stats ? objs(o.stats).map((x) => ({value: t(x.value) ?? '', label: t(x.label) ?? '', note: t(x.note)})) : undefined,
        table: table ? {columns: list(table.columns) ?? [], rows: (Array.isArray(table.rows) ? table.rows : []).map((r) => list(r) ?? [])} : undefined,
        chart: chart ? {
            type: t(chart.type),
            categories: list(chart.categories) ?? [],
            series: objs(chart.series).map((x) => ({name: t(x.name) ?? '', values: (Array.isArray(x.values) ? x.values : []).map((v) => Number(String(v).replace(/[$,%\s]/g, '')) || 0)})),
            unit: t(chart.unit),
        } : undefined,
        quote: t(o.quote), attribution: t(o.attribution),
        steps: o.steps ? objs(o.steps).map((x) => ({title: t(x.title) ?? '', text: t(x.text)})) : undefined,
        notes: t(o.notes),
    };
}

export async function makePptx(spec: DeckSpec): Promise<{data: Buffer; slides: number}> {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Captain';
    pptx.company = 'Captain';
    pptx.title = spec.title;
    pptx.theme = {headFontFace: FONT.head, bodyFontFace: FONT.body};

    const slides = spec.slides.length ? spec.slides.map(tidySlide) : [{layout: 'title', title: spec.title, subtitle: spec.subtitle}];
    let number = 0;

    const footer = (s: Slide) => {
        s.addShape(pptx.ShapeType.ellipse, {x: X0, y: 7.04, w: 0.09, h: 0.09, fill: {color: BRAND.royal}, line: {color: BRAND.royal}});
        s.addText(spec.title, {x: X0 + 0.16, y: 6.92, w: 8, h: 0.32, fontSize: 9, color: BRAND.muted, fontFace: FONT.body, margin: 0});
        s.addText(String(number), {x: W - X0 - 1, y: 6.92, w: 1, h: 0.32, fontSize: 9, color: BRAND.muted, align: 'right', fontFace: FONT.body, margin: 0});
    };

    // Kicker, headline and the short blue rule. Returns where the body starts.
    const header = (s: Slide, sl: SlideSpec): number => {
        let y = 0.55;
        if (sl.kicker) {
            s.addText(sl.kicker.toUpperCase(), {x: X0, y, w: CW, h: 0.3, fontSize: 11, bold: true, color: BRAND.royal, charSpacing: 2, margin: 0, fontFace: FONT.body});
            y += 0.34;
        }
        // One line or two: the rule sits right under the headline either way.
        const title = sl.title ?? '';
        const width = [...title.replace(/\*\*/g, '')].reduce((a, ch) => a + (/[\u2E80-\uFFEF]/.test(ch) ? 2 : 1), 0);
        const th = width > 60 ? 1.0 : 0.56;
        s.addText(rich(title), {x: X0, y, w: CW, h: th, fontSize: 28, bold: true, color: BRAND.navy, fontFace: FONT.head, valign: 'top', margin: 0, fit: 'shrink'});
        const ry = y + th + 0.12;
        s.addShape(pptx.ShapeType.rect, {x: X0, y: ry, w: 0.9, h: 0.06, fill: {color: BRAND.royal}, line: {color: BRAND.royal}});
        if (sl.subtitle) {
            s.addText(sl.subtitle, {x: X0, y: ry + 0.16, w: CW, h: 0.4, fontSize: 14, color: BRAND.muted, margin: 0, fontFace: FONT.body});
            return ry + 0.7;
        }
        return ry + 0.36;
    };

    const callout = (s: Slide, text: string, x: number, y: number, w: number, h: number) => {
        s.addShape(pptx.ShapeType.rect, {x, y, w, h, fill: {color: BRAND.goldTint}, line: {color: BRAND.goldTint}});
        s.addShape(pptx.ShapeType.rect, {x, y, w: 0.08, h, fill: {color: BRAND.gold}, line: {color: BRAND.gold}});
        s.addText(rich(text, {color: BRAND.navy}), {x: x + 0.3, y, w: w - 0.45, h, fontSize: 16, bold: true, color: BRAND.navy, valign: 'middle', margin: 0, fit: 'shrink', fontFace: FONT.body});
    };

    const dark = (s: Slide, accent: string) => {
        s.background = {color: BRAND.night};
        s.addShape(pptx.ShapeType.ellipse, {x: 8.4, y: -1.6, w: 7, h: 7, fill: {color: accent, transparency: 72}, line: {color: accent, transparency: 100}});
        s.addShape(pptx.ShapeType.ellipse, {x: 10.9, y: 4.5, w: 3.6, h: 3.6, fill: {color: BRAND.gold, transparency: 80}, line: {color: BRAND.gold, transparency: 100}});
    };

    for (const sl of slides) {
        const s = pptx.addSlide();
        number++;
        const layout = (sl.layout ?? (sl.chart ? 'chart' : sl.table ? 'table' : sl.stats ? 'stats' : sl.quote ? 'quote' : sl.steps ? 'timeline' : sl.left || sl.right ? 'two_columns' : 'bullets')).toLowerCase();

        if (layout === 'title' || layout === 'closing') {
            dark(s, BRAND.royal);
            const kicker = sl.kicker ?? (layout === 'title' ? '' : 'Next steps');
            if (kicker) {
                s.addText(kicker.toUpperCase(), {x: X0, y: 1.95, w: 8, h: 0.35, fontSize: 12, bold: true, color: BRAND.gold, charSpacing: 3, margin: 0, fontFace: FONT.body});
            }
            s.addShape(pptx.ShapeType.rect, {x: X0, y: 2.45, w: 0.9, h: 0.07, fill: {color: BRAND.gold}, line: {color: BRAND.gold}});
            s.addText(rich(sl.title ?? (layout === 'title' ? spec.title : 'Thank you')), {x: X0, y: 2.7, w: 8.6, h: 1.9, fontSize: layout === 'title' ? 44 : 40, bold: true, color: BRAND.white, fontFace: FONT.head, valign: 'top', margin: 0, fit: 'shrink'});
            if (sl.bullets?.length) {
                s.addText(bulletRuns(sl.bullets.slice(0, 5), 18, BRAND.onDark), {x: X0, y: 4.55, w: 8.4, h: 1.9, fontFace: FONT.body, valign: 'top', margin: 0, fit: 'shrink'});
            } else if (sl.subtitle ?? (layout === 'title' ? spec.subtitle : undefined)) {
                s.addText(sl.subtitle ?? spec.subtitle ?? '', {x: X0, y: 4.65, w: 8.2, h: 1, fontSize: 18, color: BRAND.onDark, valign: 'top', margin: 0, fontFace: FONT.body, fit: 'shrink'});
            }
            s.addText(`${today()}  ·  ${spec.byline}`, {x: X0, y: 6.75, w: 9, h: 0.3, fontSize: 10, color: BRAND.onDark, margin: 0, fontFace: FONT.body});
        } else if (layout === 'section') {
            s.background = {color: BRAND.royal};
            s.addShape(pptx.ShapeType.ellipse, {x: 9.2, y: 2.2, w: 6.4, h: 6.4, fill: {color: BRAND.navy, transparency: 70}, line: {color: BRAND.navy, transparency: 100}});
            s.addText(sl.kicker ?? '', {x: X0, y: 2.1, w: 6, h: 0.9, fontSize: 54, bold: true, color: BRAND.white, transparency: 35, margin: 0, fontFace: FONT.head});
            s.addText(rich(sl.title ?? ''), {x: X0, y: 3.1, w: 10, h: 1.4, fontSize: 40, bold: true, color: BRAND.white, fontFace: FONT.head, valign: 'top', margin: 0, fit: 'shrink'});
            if (sl.subtitle) {
                s.addText(sl.subtitle, {x: X0, y: 4.6, w: 9, h: 0.8, fontSize: 18, color: 'E6EDFF', margin: 0, fontFace: FONT.body});
            }
        } else if (layout === 'two_columns') {
            const top = header(s, sl);
            const gap = 0.32;
            const cw = (CW - gap) / 2;
            // Cards as tall as the longer column needs (not the whole slide).
            const perLine = Math.floor((cw - 0.9) * 9.4);
            const need = (col?: {heading?: string; bullets?: string[]}) => (col?.heading ? 0.9 : 0.35)
                + (col?.bullets ?? []).slice(0, 7).reduce((a, b) => a + Math.ceil(Math.max(1, b.length) / perLine) * 0.3 + 0.14, 0) + 0.4;
            const room = (sl.takeaway ? 5.55 : 6.65) - top;
            const h = Math.min(room, Math.max(2.4, need(sl.left), need(sl.right)));
            if (sl.takeaway) {
                callout(s, sl.takeaway, X0, Math.min(top + h + 0.3, 5.75), CW, 0.75);
            }
            [sl.left, sl.right].forEach((col, i) => {
                const x = X0 + i * (cw + gap);
                s.addShape(pptx.ShapeType.roundRect, {x, y: top, w: cw, h, fill: {color: BRAND.subtle}, line: {color: BRAND.line, width: 1}, rectRadius: 0.08});
                if (col?.heading) {
                    s.addText(rich(col.heading), {x: x + 0.35, y: top + 0.28, w: cw - 0.7, h: 0.5, fontSize: 18, bold: true, color: i ? BRAND.navy : BRAND.deep, margin: 0, fontFace: FONT.head});
                }
                s.addText(bulletRuns((col?.bullets ?? []).slice(0, 7), 15, BRAND.text), {x: x + 0.35, y: top + (col?.heading ? 0.9 : 0.35), w: cw - 0.7, h: h - (col?.heading ? 1.1 : 0.55), valign: 'top', margin: 0, fit: 'shrink', fontFace: FONT.body});
            });
            footer(s);
        } else if (layout === 'stats') {
            const top = header(s, sl);
            const stats = (sl.stats ?? []).slice(0, 4);
            const n = Math.max(1, stats.length);
            const gap = 0.3;
            const cw = (CW - gap * (n - 1)) / n;
            const h = sl.takeaway ? 2.7 : 3.4;
            stats.forEach((st, i) => {
                const x = X0 + i * (cw + gap);
                s.addShape(pptx.ShapeType.rect, {x, y: top + 0.1, w: cw, h, fill: {color: BRAND.white}, line: {color: BRAND.line, width: 1}});
                s.addShape(pptx.ShapeType.rect, {x, y: top + 0.1, w: cw, h: 0.07, fill: {color: SERIES[i % 3]}, line: {color: SERIES[i % 3]}});
                s.addText(st.value, {x: x + 0.3, y: top + 0.45, w: cw - 0.6, h: 1.1, fontSize: n > 3 ? 36 : 44, bold: true, color: BRAND.navy, margin: 0, fit: 'shrink', fontFace: FONT.head});
                s.addText(rich(st.label), {x: x + 0.3, y: top + 1.6, w: cw - 0.6, h: 0.6, fontSize: 15, bold: true, color: BRAND.text, margin: 0, valign: 'top', fit: 'shrink', fontFace: FONT.body});
                if (st.note) {
                    s.addText(st.note, {x: x + 0.3, y: top + 2.2, w: cw - 0.6, h: h - 2.25, fontSize: 12, color: BRAND.muted, margin: 0, valign: 'top', fit: 'shrink', fontFace: FONT.body});
                }
            });
            if (sl.takeaway) {
                callout(s, sl.takeaway, X0, 5.75, CW, 0.85);
            }
            footer(s);
        } else if (layout === 'table' && sl.table) {
            const top = header(s, sl);
            const cols = sl.table.columns.slice(0, 7);
            const rows = sl.table.rows.slice(0, 12);
            const lens = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i] ?? '').length), 4));
            const sum = lens.reduce((a, b) => a + Math.min(b, 40), 0);
            const colW = lens.map((l) => (Math.min(l, 40) / sum) * CW);
            const size = rows.length > 8 ? 11 : 13;
            const numeric = (v: string) => /^[-+$€£¥]?\s?[\d.,]+\s?(%|[kKmMbB]|x)?$/.test(v.trim());
            const rightCol = cols.map((_, ci) => ci > 0 && rows.filter((r) => numeric(String(r[ci] ?? ''))).length * 2 >= rows.length);
            const body = [
                cols.map((c, ci) => ({text: c, options: {bold: true, color: BRAND.white, fill: {color: BRAND.navy}, fontSize: size, valign: 'middle' as const, align: (rightCol[ci] ? 'right' : 'left') as 'right' | 'left'}})),
                ...rows.map((r, ri) => cols.map((_, ci) => {
                    const v = String(r[ci] ?? '');
                    return {text: v.replace(/\*\*/g, ''), options: {bold: /^\*\*.*\*\*$/.test(v), color: BRAND.text, fill: {color: ri % 2 ? BRAND.tint : BRAND.white}, fontSize: size, align: (rightCol[ci] ? 'right' : 'left') as 'right' | 'left', valign: 'middle' as const}};
                })),
            ];
            s.addTable(body, {x: X0, y: top + 0.05, w: CW, colW, fontFace: FONT.body, border: {type: 'solid', pt: 0.75, color: BRAND.line}, margin: [0.06, 0.12, 0.06, 0.12], rowH: rows.length > 8 ? 0.36 : 0.44, autoPage: false});
            if (sl.takeaway) {
                callout(s, sl.takeaway, X0, 6.0, CW, 0.7);
            }
            footer(s);
        } else if (layout === 'chart' && sl.chart?.categories?.length && sl.chart.series?.length) {
            const top = header(s, sl);
            const kind = (sl.chart.type ?? 'bar').toLowerCase();
            const type = kind === 'line' ? pptx.ChartType.line : kind === 'pie' ? pptx.ChartType.pie : kind === 'doughnut' ? pptx.ChartType.doughnut : kind === 'area' ? pptx.ChartType.area : pptx.ChartType.bar;
            const horizontal = kind === 'hbar' || kind === 'horizontal';
            // Horizontal bars draw bottom-up: reverse them so the first is on top.
            const order = <T, >(list: T[]) => (horizontal ? [...list].reverse() : list);
            const data = sl.chart.series.slice(0, 6).map((se) => ({name: se.name, labels: order(sl.chart!.categories), values: order(sl.chart!.categories.map((_, i) => Number(se.values[i]) || 0))}));
            const round = kind === 'pie' || kind === 'doughnut';
            const unit = sl.chart.unit ?? '';
            const format = unit === '%' ? '0"%"' : unit === '$' ? '"$"#,##0' : '#,##0';
            const w = sl.takeaway ? 8.2 : CW;
            s.addChart(type, data, {
                x: X0, y: top, w, h: 6.65 - top,
                barDir: horizontal ? 'bar' : 'col',
                barGapWidthPct: 55,
                chartColors: round ? SERIES : SERIES.slice(0, data.length),
                showLegend: round || data.length > 1, legendPos: round ? 'r' : 'b', legendFontSize: 12, legendColor: BRAND.text,
                showValue: !round && data.length === 1 && data[0].values.length <= 12, dataLabelColor: round ? BRAND.white : BRAND.text, dataLabelFontSize: 11, dataLabelFormatCode: round ? '0%' : format,
                showPercent: round, dataLabelPosition: round ? 'bestFit' : 'outEnd',
                catAxisLabelColor: BRAND.muted, catAxisLabelFontSize: 12, catAxisLineShow: true, catAxisLineColor: BRAND.line,
                valAxisLabelColor: BRAND.muted, valAxisLabelFontSize: 11, valAxisLineShow: false, valAxisLabelFormatCode: format,
                valGridLine: {color: BRAND.line, size: 0.75}, catGridLine: {style: 'none'},
                lineSize: 3, lineDataSymbol: 'circle', lineDataSymbolSize: 8,
                holeSize: 58,
            });
            if (sl.takeaway) {
                callout(s, sl.takeaway, X0 + 8.5, top + 0.4, CW - 8.5, 2.3);
            }
            footer(s);
        } else if (layout === 'quote') {
            s.addText('“', {x: X0 - 0.1, y: 0.7, w: 1.6, h: 1.6, fontSize: 140, bold: true, color: BRAND.gold, margin: 0, fontFace: FONT.head});
            s.addText(rich(sl.quote ?? sl.title ?? ''), {x: X0 + 0.9, y: 1.95, w: CW - 1.3, h: 3.2, fontSize: 30, italic: true, color: BRAND.navy, valign: 'top', margin: 0, fit: 'shrink', fontFace: FONT.head});
            if (sl.attribution) {
                s.addText(`—  ${sl.attribution}`, {x: X0 + 0.9, y: 5.35, w: CW - 1.3, h: 0.5, fontSize: 15, color: BRAND.muted, margin: 0, fontFace: FONT.body});
            }
            footer(s);
        } else if (layout === 'timeline' && sl.steps?.length) {
            const top = header(s, sl);
            const steps = sl.steps.slice(0, 6);
            const slot = CW / steps.length;
            const lineY = top + 0.85;
            s.addShape(pptx.ShapeType.line, {x: X0 + slot / 2, y: lineY, w: slot * (steps.length - 1), h: 0, line: {color: BRAND.royal, width: 2}});
            steps.forEach((st, i) => {
                const cx = X0 + slot * i + slot / 2;
                s.addShape(pptx.ShapeType.ellipse, {x: cx - 0.3, y: lineY - 0.3, w: 0.6, h: 0.6, fill: {color: i === steps.length - 1 ? BRAND.gold : BRAND.royal}, line: {color: BRAND.white, width: 2}});
                s.addText(String(i + 1), {x: cx - 0.3, y: lineY - 0.3, w: 0.6, h: 0.6, fontSize: 15, bold: true, color: BRAND.white, align: 'center', valign: 'middle', margin: 0, fontFace: FONT.body});
                s.addText(rich(st.title), {x: cx - slot / 2 + 0.1, y: lineY + 0.5, w: slot - 0.2, h: 0.7, fontSize: 15, bold: true, color: BRAND.navy, align: 'center', valign: 'top', margin: 0, fit: 'shrink', fontFace: FONT.body});
                if (st.text) {
                    s.addText(rich(st.text), {x: cx - slot / 2 + 0.12, y: lineY + 1.2, w: slot - 0.24, h: 6.5 - lineY - 1.2, fontSize: 12, color: BRAND.muted, align: 'center', valign: 'top', margin: 0, fit: 'shrink', fontFace: FONT.body});
                }
            });
            footer(s);
        } else if (!(sl.bullets ?? []).some((b) => b.trim())) {
            // Only a headline: say it big, in the middle of the slide.
            if (sl.kicker) {
                s.addText(sl.kicker.toUpperCase(), {x: X0, y: 2.35, w: CW, h: 0.3, fontSize: 12, bold: true, color: BRAND.royal, charSpacing: 2, margin: 0, fontFace: FONT.body});
            }
            s.addShape(pptx.ShapeType.rect, {x: X0, y: 2.8, w: 0.9, h: 0.07, fill: {color: BRAND.royal}, line: {color: BRAND.royal}});
            s.addText(rich(sl.title ?? ''), {x: X0, y: 3.05, w: CW - 1, h: 1.6, fontSize: 36, bold: true, color: BRAND.navy, fontFace: FONT.head, valign: 'top', margin: 0, fit: 'shrink'});
            const under = sl.takeaway ?? sl.subtitle;
            if (under) {
                s.addText(rich(under), {x: X0, y: 4.75, w: CW - 1, h: 0.9, fontSize: 18, color: BRAND.muted, valign: 'top', margin: 0, fit: 'shrink', fontFace: FONT.body});
            }
            footer(s);
        } else {
            const top = header(s, sl);
            const items = (sl.bullets ?? []).filter((b) => b.trim()).slice(0, 8);
            const size = items.length > 5 ? 17 : 20;
            const bottom = sl.takeaway ? 5.55 : 6.65;
            s.addText(bulletRuns(items, size, BRAND.text), {x: X0, y: top + 0.05, w: CW, h: bottom - top - 0.1, valign: 'top', margin: 0, fit: 'shrink', fontFace: FONT.body});
            if (sl.takeaway) {
                callout(s, sl.takeaway, X0, 5.75, CW, 0.85);
            }
            footer(s);
        }
        if (sl.notes) {
            s.addNotes(sl.notes);
        }
    }
    const data = await tidy((await pptx.write({outputType: 'nodebuffer'})) as Buffer);
    return {data, slides: slides.length};
}
