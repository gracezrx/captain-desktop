// An Excel workbook from tables, in Captain's look: a title row, a navy
// header row that stays put while you scroll, banded rows, number formats
// by column, filters, and a totals row with real SUM formulas.

import ExcelJS from 'exceljs';

import {BRAND, FONT} from './theme.js';

export type ColumnType = 'text' | 'number' | 'integer' | 'currency' | 'percent' | 'date';
export type SheetSpec = {
    name: string;
    title?: string;
    note?: string;
    columns: {header: string; type?: ColumnType; width?: number}[];
    rows: (string | number | boolean | null)[][];
    totals?: boolean;
};

const FORMAT: Record<ColumnType, string | undefined> = {
    text: undefined,
    number: '#,##0.##',
    integer: '#,##0',
    currency: '"$"#,##0.00',
    percent: '0.0%',
    date: 'mmm d, yyyy',
};

const argb = (c: string) => `FF${c}`;

export function coerce(v: string | number | boolean | null | undefined, type: ColumnType): ExcelJS.CellValue {
    if (v === null || v === undefined || v === '') {
        return null;
    }
    if (type === 'text') {
        return typeof v === 'string' ? v : String(v);
    }
    if (type === 'date') {
        const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
        return Number.isNaN(d.getTime()) ? String(v) : d;
    }
    if (typeof v === 'number') {
        return v;
    }
    const s = String(v).trim();
    const pct = s.endsWith('%');
    const n = Number(s.replace(/[$€£¥,%\s]/g, ''));
    if (!Number.isFinite(n)) {
        return s;
    }
    return type === 'percent' && (pct || Math.abs(n) > 1) ? n / 100 : n;
}

// Sheet names: up to 31 characters, none of []:*?/\ and each one different.
function sheetName(raw: string, taken: Set<string>): string {
    const base = (raw || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Sheet';
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) {
        name = `${base} ${i}`;
    }
    taken.add(name.toLowerCase());
    return name;
}

function columnLetter(n: number): string {
    let s = '';
    for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) {
        s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    }
    return s;
}

export async function makeXlsx(title: string, sheets: SheetSpec[]): Promise<{data: Buffer; sheets: number; rows: number}> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Captain';
    wb.title = title;
    wb.created = new Date();
    const taken = new Set<string>();
    let rowsTotal = 0;

    for (const spec of sheets.slice(0, 20)) {
        const cols = spec.columns.slice(0, 50);
        if (!cols.length) {
            continue;
        }
        const ws = wb.addWorksheet(sheetName(spec.name, taken), {views: [{showGridLines: false}]});
        const types = cols.map((c) => c.type ?? 'text');
        const last = columnLetter(cols.length);

        // Title (and a note) above the table.
        ws.mergeCells(`A1:${last}1`);
        const t = ws.getCell('A1');
        t.value = spec.title ?? spec.name ?? title;
        t.font = {name: FONT.body, size: 15, bold: true, color: {argb: argb(BRAND.navy)}};
        ws.getRow(1).height = 26;
        let headerRow = 3;
        if (spec.note) {
            ws.mergeCells(`A2:${last}2`);
            const n = ws.getCell('A2');
            n.value = spec.note;
            n.font = {name: FONT.body, size: 10, italic: true, color: {argb: argb(BRAND.muted)}};
            headerRow = 4;
        }

        const header = ws.getRow(headerRow);
        cols.forEach((c, i) => {
            const cell = header.getCell(i + 1);
            cell.value = c.header;
            cell.font = {name: FONT.body, size: 11, bold: true, color: {argb: argb(BRAND.white)}};
            cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: argb(BRAND.navy)}};
            cell.alignment = {vertical: 'middle', horizontal: types[i] === 'text' || types[i] === 'date' ? 'left' : 'right', wrapText: true};
        });
        header.height = 24;

        const rows = spec.rows.slice(0, 5000);
        rows.forEach((r, ri) => {
            const row = ws.getRow(headerRow + 1 + ri);
            cols.forEach((_, ci) => {
                const cell = row.getCell(ci + 1);
                cell.value = coerce(r[ci], types[ci]);
                cell.font = {name: FONT.body, size: 11, color: {argb: argb(BRAND.text)}};
                const fmt = FORMAT[types[ci]];
                if (fmt) {
                    cell.numFmt = fmt;
                }
                if (ri % 2 === 1) {
                    cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: argb(BRAND.tint)}};
                }
                cell.border = {bottom: {style: 'thin', color: {argb: argb(BRAND.line)}}};
                cell.alignment = {vertical: 'middle', horizontal: types[ci] === 'text' || types[ci] === 'date' ? 'left' : 'right'};
            });
        });
        rowsTotal += rows.length;

        const first = headerRow + 1;
        const lastData = headerRow + rows.length;
        if (spec.totals && rows.length) {
            const row = ws.getRow(lastData + 1);
            cols.forEach((_, ci) => {
                const cell = row.getCell(ci + 1);
                const numeric = ['number', 'integer', 'currency'].includes(types[ci]);
                if (ci === 0 && !numeric) {
                    cell.value = 'Total';
                } else if (numeric) {
                    const L = columnLetter(ci + 1);
                    cell.value = {formula: `SUM(${L}${first}:${L}${lastData})`};
                    cell.numFmt = FORMAT[types[ci]] ?? '#,##0';
                }
                cell.font = {name: FONT.body, size: 11, bold: true, color: {argb: argb(BRAND.navy)}};
                cell.border = {top: {style: 'medium', color: {argb: argb(BRAND.navy)}}};
                cell.alignment = {horizontal: numeric ? 'right' : 'left'};
            });
        }

        // Widths from the content as it will show (with its number format), unless given.
        const shown = (v: unknown, type: ColumnType): string => {
            const x = coerce(v as string, type);
            if (typeof x === 'number') {
                const opts = type === 'currency' ? {minimumFractionDigits: 2, maximumFractionDigits: 2} : {maximumFractionDigits: 2};
                return `${type === 'currency' ? '$' : ''}${(type === 'percent' ? x * 100 : x).toLocaleString('en-US', opts)}${type === 'percent' ? '%' : ''}`;
            }
            return x instanceof Date ? 'Mmm 00, 0000' : String(x ?? '');
        };
        cols.forEach((c, ci) => {
            const values = rows.slice(0, 300).map((r) => shown(r[ci], types[ci]));
            let longest = Math.max(c.header.length + 2, ...values.map((v) => v.length));
            if (spec.totals && ['number', 'integer', 'currency'].includes(types[ci])) {
                const sum = rows.reduce((a, r) => a + (Number(coerce(r[ci], types[ci])) || 0), 0);
                longest = Math.max(longest, shown(sum, types[ci]).length + 2);
            }
            ws.getColumn(ci + 1).width = c.width ?? Math.min(60, Math.max(12, longest + 4));
        });
        for (let r = headerRow + 1; r <= lastData + (spec.totals ? 1 : 0); r++) {
            ws.getRow(r).height = 20;
        }
        ws.views = [{state: 'frozen', ySplit: headerRow, showGridLines: false}];
        if (rows.length) {
            ws.autoFilter = {from: {row: headerRow, column: 1}, to: {row: lastData, column: cols.length}};
        }
    }
    if (!wb.worksheets.length) {
        wb.addWorksheet('Sheet 1');
    }
    const data = Buffer.from(await wb.xlsx.writeBuffer());
    return {data, sheets: wb.worksheets.length, rows: rowsTotal};
}
