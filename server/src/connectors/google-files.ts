// New Google Docs, Slides and Sheets in the asker's own Drive, made through
// the Google apps they connected (Composio), and filed in a "Captain › <chat>"
// folder when Drive is connected too.
//
// The action names are the ones Composio publishes. Their inputs are read
// from each action's schema and matched by name, so an input Composio
// renames (markdown → markdown_text, say) still lines up. Every step is best
// effort: if Google says no, the Office file the agent made is still there.

import type {Ctx} from '../app/context.js';
import {coerce, type ColumnType, type SheetSpec} from '../files/make/xlsx.js';
import type {ChannelRow} from '../store/channels.js';
import type {GoogleApp} from '../shared/types.js';
import type {UserRow} from '../store/users.js';
import {log} from '../util/log.js';

import {composioUserId} from './composio.js';

export type Google = {ctx: Ctx; user: string; accounts: Map<string, string>};
export type GoogleFile = {app: GoogleApp; id: string; url: string; folder?: string};

const TOOLKIT: Record<GoogleApp, string> = {docs: 'googledocs', slides: 'googleslides', sheets: 'googlesheets'};
const URL_PATH: Record<GoogleApp, string> = {docs: 'document', slides: 'presentation', sheets: 'spreadsheets'};

export const MAKE_ACTIONS = {
    doc: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    slides: 'GOOGLESLIDES_CREATE_SLIDES_MARKDOWN',
    sheet: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    addSheet: 'GOOGLESHEETS_ADD_SHEET',
    values: 'GOOGLESHEETS_VALUES_UPDATE',
    folder: 'GOOGLEDRIVE_CREATE_FOLDER',
    move: 'GOOGLEDRIVE_MOVE_FILE',
} as const;

export function googleUrl(app: GoogleApp, id: string): string {
    return `https://docs.google.com/${URL_PATH[app]}/d/${encodeURIComponent(id)}/edit`;
}

// The asker's connected Google apps in this workspace, or null when there
// are none (or connections aren't set up on this server).
export async function googleFor(ctx: Ctx, requester: UserRow, workspaceId: string): Promise<Google | null> {
    if (!ctx.composio.configured() || requester.isBot) {
        return null;
    }
    const user = composioUserId(requester.id, workspaceId);
    try {
        const accounts = new Map((await ctx.composio.connections(user)).filter((c) => c.status === 'ACTIVE').map((c) => [c.toolkit, c.id]));
        return accounts.size ? {ctx, user, accounts} : null;
    } catch (err) {
        log.warn({err: (err as Error).message}, 'couldn\'t list Google connections; making Office files only');
        return null;
    }
}

export function canMake(g: Google | null, app: GoogleApp): g is Google {
    return Boolean(g?.accounts.has(TOOLKIT[app]));
}

// Arguments for an action: each value goes to the first input the action
// has under one of its names (exactly, then ignoring case and underscores).
type Want = [names: string[], value: unknown];
export function fill(parameters: Record<string, unknown> | null, wants: Want[]): Record<string, unknown> {
    const props = Object.keys((parameters?.properties ?? {}) as Record<string, unknown>);
    const norm = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
    const out: Record<string, unknown> = {};
    for (const [names, value] of wants) {
        if (value === undefined) {
            continue;
        }
        const hit = props.length ?
            names.map((n) => props.find((p) => p === n) ?? props.find((p) => norm(p) === norm(n))).find(Boolean) :
            names[0];
        if (hit && !(hit in out)) {
            out[hit] = value;
        }
    }
    return out;
}

// The id of what an action made, wherever its answer keeps it: under one of
// the given keys, or inside a docs.google.com / drive link.
export function madeId(data: unknown, keys: string[]): string | null {
    const queue: unknown[] = [data];
    const links: string[] = [];
    for (let seen = 0; queue.length && seen < 400; seen++) {
        const v = queue.shift();
        if (typeof v === 'string') {
            links.push(v);
            continue;
        }
        if (!v || typeof v !== 'object') {
            continue;
        }
        const o = v as Record<string, unknown>;
        for (const k of keys) {
            if (typeof o[k] === 'string' && /^[\w-]{10,}$/.test(o[k] as string)) {
                return o[k] as string;
            }
        }
        queue.push(...(Array.isArray(v) ? v : Object.values(o)));
    }
    for (const s of links) {
        const m = s.match(/\/(?:document|presentation|spreadsheets|file|folders)\/(?:d\/)?([\w-]{10,})/);
        if (m) {
            return m[1];
        }
    }
    return null;
}

class GoogleSaidNo extends Error {}

async function act(g: Google, toolkit: string, slug: string, wants: Want[]): Promise<unknown> {
    const account = g.accounts.get(toolkit);
    if (!account) {
        throw new GoogleSaidNo(`${toolkit} isn't connected`);
    }
    const schema = await g.ctx.composio.schema(slug);
    if (!schema) {
        throw new GoogleSaidNo(`Composio has no ${slug}`);
    }
    const res = await g.ctx.composio.execute(slug, g.user, account, fill(schema.parameters, wants));
    if (!res.ok) {
        throw new GoogleSaidNo(res.error ?? 'no reason given');
    }
    return res.data;
}

const TITLE: string[] = ['title', 'document_title', 'presentation_title', 'name'];
const MARKDOWN: string[] = ['markdown_text', 'markdown', 'text', 'content', 'markdownText'];
const SHEET_ID: string[] = ['spreadsheet_id', 'spreadsheetId', 'id'];

// --- Drive folders: "Captain", then one per chat inside it -----------------

function chatFolderName(channel: ChannelRow): string {
    if (channel.type === 'D') {
        return 'Direct messages';
    }
    return (channel.displayName || channel.name || 'Chat').replace(/[\\/]/g, ' ').trim().slice(0, 100) || 'Chat';
}

async function savedFolder(g: Google, channelId: string): Promise<string | null> {
    const [row] = await g.ctx.sql`select folder_id from google_folders where composio_user = ${g.user} and channel_id = ${channelId}`;
    return (row?.folderId as string | undefined) ?? null;
}

async function makeFolder(g: Google, channelId: string, name: string, parent: string | null): Promise<string> {
    const data = await act(g, 'googledrive', MAKE_ACTIONS.folder, [
        [['folder_name', 'name', 'title'], name],
        [['parent_id', 'parent_folder_id', 'parent', 'parents'], parent ?? undefined],
    ]);
    const id = madeId(data, ['id', 'folder_id', 'folderId', 'fileId']);
    if (!id) {
        throw new GoogleSaidNo('no folder id in the answer');
    }
    await g.ctx.sql`
        insert into google_folders (composio_user, channel_id, folder_id) values (${g.user}, ${channelId}, ${id})
        on conflict (composio_user, channel_id) do update set folder_id = excluded.folder_id`;
    return id;
}

async function forgetFolders(g: Google, channelId: string): Promise<void> {
    await g.ctx.sql`delete from google_folders where composio_user = ${g.user} and channel_id in ('', ${channelId})`;
}

async function fileAway(g: Google, fileId: string, channel: ChannelRow): Promise<string | undefined> {
    if (!g.accounts.has('googledrive')) {
        return undefined;
    }
    const name = chatFolderName(channel);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const top = (await savedFolder(g, '')) ?? (await makeFolder(g, '', 'Captain', null));
            const chat = (await savedFolder(g, channel.id)) ?? (await makeFolder(g, channel.id, name, top));
            await act(g, 'googledrive', MAKE_ACTIONS.move, [
                [['file_id', 'fileId', 'id'], fileId],
                [['add_parents', 'addParents', 'destination_folder_id', 'folder_id', 'new_parent_id'], chat],
                [['remove_parents', 'removeParents'], 'root'],
            ]);
            return `Captain › ${name}`;
        } catch (err) {
            const msg = (err as Error).message;
            // A folder someone deleted in Drive: make them again, once.
            if (attempt === 0 && /not ?found|404|trashed/i.test(msg)) {
                await forgetFolders(g, channel.id);
                continue;
            }
            log.warn({err: msg}, 'couldn\'t file the new Google file in its folder; it stays in My Drive');
            return undefined;
        }
    }
    return undefined;
}

// --- The three kinds of file -------------------------------------------------

async function made(g: Google, app: GoogleApp, data: unknown, keys: string[], channel: ChannelRow): Promise<GoogleFile> {
    const id = madeId(data, keys);
    if (!id) {
        throw new GoogleSaidNo('no file id in the answer');
    }
    const folder = await fileAway(g, id, channel);
    return {app, id, url: googleUrl(app, id), ...(folder ? {folder} : {})};
}

export async function googleDoc(g: Google, channel: ChannelRow, title: string, markdown: string): Promise<GoogleFile> {
    const data = await act(g, TOOLKIT.docs, MAKE_ACTIONS.doc, [[TITLE, title], [MARKDOWN, markdown]]);
    return made(g, 'docs', data, ['documentId', 'document_id', 'id'], channel);
}

export async function googleSlides(g: Google, channel: ChannelRow, title: string, markdown: string): Promise<GoogleFile> {
    const data = await act(g, TOOLKIT.slides, MAKE_ACTIONS.slides, [[TITLE, title], [MARKDOWN, markdown]]);
    return made(g, 'slides', data, ['presentationId', 'presentation_id', 'id'], channel);
}

function columnLetter(n: number): string {
    let s = '';
    for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) {
        s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    }
    return s;
}

// A cell as typed into Google Sheets, so it shows like the Excel file:
// "$1,200.00", "40%", "2026-10-31" (Sheets reads these as numbers and dates).
function typed(v: string | number | boolean | null | undefined, type: ColumnType): string | number | boolean {
    const x = coerce(v, type);
    if (x === null || x === undefined) {
        return '';
    }
    // Text that Sheets would run as a formula (=IMPORTDATA(…), +, -, @) stays text.
    if (typeof x === 'string' && /^[=+\-@\t\r]/.test(x)) {
        return `'${x}`;
    }
    if (x instanceof Date) {
        return x.toISOString().slice(0, 10);
    }
    if (typeof x === 'number') {
        if (type === 'currency') {
            return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        }
        if (type === 'percent') {
            return `${+(x * 100).toFixed(4)}%`;
        }
    }
    return x as string | number | boolean;
}

// A sheet's cells as Google takes them ("entered as typed": numbers stay
// numbers, the totals row is real formulas), starting at row `top`.
export function sheetValues(spec: SheetSpec, top: number): (string | number | boolean)[][] {
    const cols = spec.columns.slice(0, 50);
    const text = (s: string) => typed(s, 'text');
    const out: (string | number | boolean)[][] = [[text(spec.title ?? spec.name)]];
    if (spec.note) {
        out.push([text(spec.note)]);
    }
    out.push([]);
    out.push(cols.map((c) => text(c.header)));
    const first = top + out.length;
    const rows = spec.rows.slice(0, 5000);
    for (const r of rows) {
        out.push(cols.map((c, i) => typed(r[i], c.type ?? 'text')));
    }
    const numeric = (t?: ColumnType) => t === 'number' || t === 'integer' || t === 'currency';
    if (spec.totals && rows.length) {
        const last = first + rows.length - 1;
        out.push(cols.map((c, i) => (numeric(c.type) ? `=SUM(${columnLetter(i + 1)}${first}:${columnLetter(i + 1)}${last})` : i === 0 ? 'Total' : '')));
    }
    return out;
}

export async function googleSheet(g: Google, channel: ChannelRow, title: string, sheets: SheetSpec[]): Promise<GoogleFile> {
    const data = await act(g, TOOLKIT.sheets, MAKE_ACTIONS.sheet, [[['title', 'name', 'spreadsheet_title'], title]]);
    const id = madeId(data, ['spreadsheetId', 'spreadsheet_id', 'id']);
    if (!id) {
        throw new GoogleSaidNo('no spreadsheet id in the answer');
    }
    let below = 1; // the next free row on the first sheet, when tabs can't be added
    for (const [i, spec] of sheets.slice(0, 20).entries()) {
        let range = `A${below}`;
        if (i > 0) {
            const name = spec.name.replace(/[[\]:*?/\\']/g, ' ').trim().slice(0, 90) || `Sheet ${i + 1}`;
            try {
                await act(g, TOOLKIT.sheets, MAKE_ACTIONS.addSheet, [[SHEET_ID, id], [['properties'], {title: name}], [['title', 'sheet_name', 'name'], name]]);
                range = `'${name}'!A1`;
            } catch (err) {
                log.warn({err: (err as Error).message}, 'couldn\'t add a tab to the Google Sheet; putting the table below');
            }
        }
        const top = range.startsWith('\'') ? 1 : below;
        const values = sheetValues(spec, top);
        await act(g, TOOLKIT.sheets, MAKE_ACTIONS.values, [
            [SHEET_ID, id],
            [['range'], range],
            [['values'], values],
            [['value_input_option', 'valueInputOption'], 'USER_ENTERED'],
        ]);
        if (!range.startsWith('\'')) {
            below += values.length + 2;
        }
    }
    const folder = await fileAway(g, id, channel);
    return {app: 'sheets', id, url: googleUrl('sheets', id), ...(folder ? {folder} : {})};
}
