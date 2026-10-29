// The Chrome extension: the same compact panel as the Mac app's menu bar
// panel (write, inbox, decide in place), in the toolbar popup and in Chrome's
// side panel, plus buttons that bring the current page into a message.

import {BookOpen, Link2, PanelRight, TextQuote} from 'lucide-react';
import {useEffect, useState} from 'react';

import {AuthScreen} from '../components/AuthScreen';
import type {Incoming} from '../components/Composer';
import {errorMessage} from '../lib/api';
import {resume, startSession} from '../lib/boot';
import {extensionSurface, onPanelTarget, type PanelTarget} from '../lib/native';
import {useStore} from '../lib/store';
import {Ready} from '../panel/Panel';

import {dataUrlToBlob, pageFile, pageLink, quote, readTab, TabError} from './tab';

const HINTS = ['⏎ send', '⇧⏎ new line', 'right-click a page to send it'];

export function ExtensionApp() {
    const [phase, setPhase] = useState<'loading' | 'signed-out' | 'ready'>('loading');
    const [target, setTarget] = useState<PanelTarget>({mode: 'compose'});
    const [incoming, setIncoming] = useState<Incoming | null>(null);

    useEffect(() => {
        resume().then((ok) => setPhase(ok ? 'ready' : 'signed-out'));
    }, []);

    useEffect(() => onPanelTarget(setTarget), []);

    // Something sent from the right-click menu (see background.ts).
    useEffect(() => {
        const take = async () => {
            const {pending} = await chrome.storage.session.get('pending');
            if (!pending) {
                return;
            }
            await chrome.storage.session.remove('pending');
            setTarget({mode: 'compose'});
            setIncoming(await fromMenu(pending as Pending));
        };
        void take();
        const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === 'session' && changes.pending?.newValue) {
                void take();
            }
        };
        chrome.storage.onChanged.addListener(onChange);
        return () => chrome.storage.onChanged.removeListener(onChange);
    }, []);

    if (phase === 'loading') {
        return <div className='grid h-40 place-items-center'><img src='/captain-mark.png' alt='' className='size-8 animate-pulse opacity-60'/></div>;
    }
    if (phase === 'signed-out') {
        return (
            <div className='ext-auth'>
                <AuthScreen onSignedIn={async (session) => {
                    setPhase('loading');
                    await startSession(session);
                    setPhase('ready');
                }}/>
            </div>
        );
    }
    return (
        <div className='ext-panel'>
            <Ready
                target={target}
                setTarget={setTarget}
                extras={{
                    tools: <PageTools onAdd={setIncoming}/>,
                    incoming,
                    header: extensionSurface === 'popup' ? <SidePanelButton/> : null,
                    hints: HINTS,
                    keepOpenAfterSend: extensionSurface === 'sidepanel',
                    openThreadAfterSend: extensionSurface === 'sidepanel',
                    tall: extensionSurface === 'sidepanel',
                }}
            />
        </div>
    );
}

type Pending = {nonce: number; kind: string; url?: string; title?: string; selection?: string; imageUrl?: string; screenshot?: string};

async function fromMenu(p: Pending): Promise<Incoming> {
    const link = p.url ? pageLink(p.title ?? '', p.url) : '';
    if (p.kind === 'selection' && p.selection) {
        return {nonce: p.nonce, text: `${quote(p.selection)}\n— ${link}`};
    }
    if (p.kind === 'screenshot' && p.screenshot) {
        return {nonce: p.nonce, text: link, files: [{blob: await dataUrlToBlob(p.screenshot)}]};
    }
    if (p.kind === 'image' && p.imageUrl) {
        try {
            const blob = await (await fetch(p.imageUrl)).blob();
            if (blob.type.startsWith('image/')) {
                return {nonce: p.nonce, text: link, files: [{blob}]};
            }
        } catch {
            // can't fetch it: send the link instead
        }
        return {nonce: p.nonce, text: `${p.imageUrl}\n— ${link}`};
    }
    return {nonce: p.nonce, text: link};
}

// Bring the current page into the message: a link, the selected text, or
// the page's text for agents to read. Each one only when clicked.
function PageTools({onAdd}: {onAdd: (i: Incoming) => void}) {
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const ready = useStore((s) => s.ready);

    const run = async (which: string, make: () => Promise<Omit<Incoming, 'nonce'>>) => {
        setBusy(which);
        setNote(null);
        try {
            onAdd({nonce: Date.now(), ...(await make())});
        } catch (e) {
            setNote(e instanceof TabError ? e.message : errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    if (!ready) {
        return null;
    }
    const chip = 'inline-flex h-7 items-center gap-1.5 rounded-full bg-surface/80 px-2.5 text-[12px] font-semibold text-text ring-1 ring-line hover:bg-surface disabled:opacity-50';
    return (
        <div className='mb-2'>
            <div className='flex flex-wrap gap-1.5'>
                <button type='button' className={chip} disabled={!!busy} title='Add a link to this page' onClick={() => void run('link', async () => {
                    const p = await readTab();
                    return {text: pageLink(p.title, p.url)};
                })}>
                    <Link2 size={13}/> This page
                </button>
                <button type='button' className={chip} disabled={!!busy} title='Quote the text you selected on the page' onClick={() => void run('quote', async () => {
                    const p = await readTab();
                    if (!p.selection) {
                        throw new TabError('Select some text on the page first.');
                    }
                    return {text: `${quote(p.selection)}\n— ${pageLink(p.title, p.url)}`};
                })}>
                    <TextQuote size={13}/> Selection
                </button>
                <button type='button' className={chip} disabled={!!busy} title='Attach the page’s text so agents can read it' onClick={() => void run('read', async () => {
                    const p = await readTab();
                    if (!p.text) {
                        throw new TabError('This page has no text to read.');
                    }
                    return {files: [pageFile(p)]};
                })}>
                    <BookOpen size={13}/> {busy === 'read' ? 'Reading…' : 'Let agents read it'}
                </button>
            </div>
            {note && <p className='mt-1.5 px-1 text-[12px] text-alert'>{note}</p>}
        </div>
    );
}

function SidePanelButton() {
    // Known ahead of the click: Chrome opens the side panel only straight from one.
    const [windowId, setWindowId] = useState<number | null>(null);
    useEffect(() => {
        void chrome.windows.getCurrent().then((w) => setWindowId(w.id ?? null));
    }, []);
    return (
        <button
            type='button'
            title='Open in the side panel'
            aria-label='Open in the side panel'
            disabled={windowId === null}
            className='grid size-7 place-items-center rounded-full text-muted hover:bg-tint hover:text-ink'
            onClick={() => {
                void chrome.sidePanel.open({windowId: windowId!}).then(() => window.close());
            }}
        >
            <PanelRight size={15}/>
        </button>
    );
}
