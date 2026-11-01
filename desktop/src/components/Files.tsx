import {Download, ExternalLink, FolderClosed} from 'lucide-react';

import {fileUrl} from '../lib/api';
import {openExternal} from '../lib/native';
import type {FileInfo, GoogleApp} from '../lib/types';

function size(n: number): string {
    return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Tone = 'accent' | 'gold' | 'success' | 'alert' | 'muted';
type Kind = {label: string; badge: string; tone: Tone; download: string; viewable?: boolean};

// One card family for every file: what it is, its name, "kind · length · size".
const KINDS: Record<string, Kind> = {
    docx: {label: 'Word document', badge: 'DOC', tone: 'accent', download: 'Word'},
    doc: {label: 'Word document', badge: 'DOC', tone: 'accent', download: 'Word'},
    pdf: {label: 'PDF', badge: 'PDF', tone: 'alert', download: 'PDF', viewable: true},
    pptx: {label: 'PowerPoint', badge: 'PPT', tone: 'gold', download: 'PowerPoint'},
    ppt: {label: 'PowerPoint', badge: 'PPT', tone: 'gold', download: 'PowerPoint'},
    key: {label: 'Keynote', badge: 'KEY', tone: 'gold', download: 'Keynote'},
    xlsx: {label: 'Excel workbook', badge: 'XLS', tone: 'success', download: 'Excel'},
    xls: {label: 'Excel workbook', badge: 'XLS', tone: 'success', download: 'Excel'},
    csv: {label: 'CSV', badge: 'CSV', tone: 'success', download: 'CSV', viewable: true},
    md: {label: 'Markdown', badge: 'MD', tone: 'muted', download: 'Markdown', viewable: true},
    txt: {label: 'Text', badge: 'TXT', tone: 'muted', download: 'Text', viewable: true},
};

const GOOGLE: Record<GoogleApp, {label: string; open: string; tone: Tone; badge: string}> = {
    docs: {label: 'Google Doc', open: 'Open in Docs', tone: 'accent', badge: 'DOC'},
    slides: {label: 'Google Slides', open: 'Open in Slides', tone: 'gold', badge: 'SLIDES'},
    sheets: {label: 'Google Sheet', open: 'Open in Sheets', tone: 'success', badge: 'SHEET'},
};

const TONE: Record<Tone, string> = {
    accent: 'bg-tint text-accent-text',
    gold: 'bg-gold-tint text-gold-text',
    success: 'bg-success-tint text-success',
    alert: 'bg-alert/10 text-alert',
    muted: 'bg-bg-subtle text-muted ring-1 ring-line',
};

function kindOf(f: FileInfo): Kind {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    return KINDS[ext] ?? {label: ext ? ext.toUpperCase() : 'File', badge: (ext || 'file').slice(0, 4).toUpperCase(), tone: 'muted', download: 'Download'};
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function length(f: FileInfo): string | null {
    const p = f.props ?? {};
    if (p.words !== undefined && p.made === 'document') {
        return plural(p.words, 'word');
    }
    if (p.slides !== undefined) {
        return plural(p.slides, 'slide');
    }
    if (p.sheets !== undefined) {
        return p.sheets > 1 ? plural(p.sheets, 'sheet') : plural(p.rows ?? 0, 'row');
    }
    return null;
}

// Attachments: pictures inline, everything else as a file card. A PDF that is
// a copy of another file in the message shows as a download on that card.
export function Files({files, compact = false, onOpenImage}: {files: FileInfo[]; compact?: boolean; onOpenImage?: (url: string) => void}) {
    if (!files.length) {
        return null;
    }
    const byId = new Map(files.map((f) => [f.id, f]));
    const shown = files.filter((f) => !(f.props?.copyOf && byId.has(f.props.copyOf)));
    return (
        <div className='mt-1.5 flex flex-wrap gap-2'>
            {shown.map((f) => (f.mime.startsWith('image/') ? (
                <button key={f.id} type='button' onClick={() => onOpenImage?.(fileUrl(f))} className='block' title={f.name}>
                    <img
                        src={fileUrl(f)}
                        alt={f.name}
                        loading='lazy'
                        className={`${compact ? 'max-h-36' : 'max-h-64'} max-w-full rounded-xl object-cover ring-1 ring-line`}
                        style={f.width && f.height ? {aspectRatio: `${f.width} / ${f.height}`} : undefined}
                        draggable={false}
                    />
                </button>
            ) : (
                <FileCard key={f.id} file={f} pdf={f.props?.pdf ? byId.get(f.props.pdf) : undefined} compact={compact}/>
            )))}
        </div>
    );
}

function Badge({text, tone, compact}: {text: string; tone: Tone; compact: boolean}) {
    return (
        <span className={`relative grid shrink-0 place-items-center rounded-lg font-extrabold tracking-wide ${TONE[tone]} ${compact ? 'h-9 w-8 text-[8.5px]' : 'h-11 w-9 text-[9.5px]'}`} aria-hidden>
            {/* a folded corner, so it reads as a page */}
            <span className='absolute top-0 right-0 size-2.5 rounded-bl-md rounded-tr-lg bg-[var(--surface)] opacity-70'/>
            {text}
        </span>
    );
}

export function FileCard({file, pdf, compact = false}: {file: FileInfo; pdf?: FileInfo; compact?: boolean}) {
    const kind = kindOf(file);
    const google = file.props?.google;
    const g = google ? GOOGLE[google.app] : null;
    const meta = [g?.label ?? kind.label, length(file), g ? null : size(file.size)].filter(Boolean).join(' · ');
    const open = (url: string) => void openExternal(url).catch((err) => console.warn('open failed', err));
    // Open: the Google file, the file itself when a browser shows it, or its PDF copy.
    const openUrl = google?.url ?? (kind.viewable ? fileUrl(file) : pdf ? fileUrl(pdf) : null);
    const downloads = [{file, label: kind.download}, ...(pdf ? [{file: pdf, label: 'PDF'}] : [])];
    const chip = 'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold transition-colors';

    return (
        <div className={`flex min-w-0 flex-col rounded-2xl bg-surface ring-1 ring-line ${compact ? 'w-64 gap-2 p-2.5' : 'w-80 gap-2.5 p-3'}`}>
            <div className='flex min-w-0 items-center gap-2.5'>
                <Badge text={g?.badge ?? kind.badge} tone={g?.tone ?? kind.tone} compact={compact}/>
                <span className='min-w-0'>
                    <span className={`block truncate font-semibold text-ink ${compact ? 'text-[12.5px]' : 'text-[13.5px]'}`} title={file.name}>{google || file.props?.made ? file.name.replace(/\.[^.]+$/, '') : file.name}</span>
                    <span className='block truncate text-[11.5px] text-muted'>{meta}</span>
                </span>
            </div>
            {google?.folder && !compact && (
                <div className='-mt-1 flex items-center gap-1 pl-[46px] text-[11px] text-muted'>
                    <FolderClosed size={11}/> {google.folder}
                </div>
            )}
            <div className='flex flex-wrap items-center gap-1.5'>
                {openUrl ? (
                    <button type='button' onClick={() => open(openUrl)} className={`${chip} bg-accent text-on-accent`} style={{boxShadow: 'var(--shadow-send)'}}>
                        <ExternalLink size={12} strokeWidth={2.5}/> {g?.open ?? 'Open'}
                    </button>
                ) : null}
                {downloads.map((d, i) => {
                    const primary = !openUrl && i === 0;
                    return (
                        <a key={d.file.id} href={fileUrl(d.file, true)} target='_blank' rel='noreferrer' title={`Download ${d.file.name}`} className={`${chip} ${primary ? 'bg-accent text-on-accent' : 'text-ink ring-1 ring-line hover:bg-tint'}`} style={primary ? {boxShadow: 'var(--shadow-send)'} : undefined}>
                            <Download size={12} strokeWidth={2.5}/> {primary ? 'Download' : d.label}
                        </a>
                    );
                })}
            </div>
        </div>
    );
}
