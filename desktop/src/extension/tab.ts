// The browser tab next to the extension's popup or side panel: its address,
// selected text, readable text and a screenshot. Each is read only when the
// person clicks for it. The popup can read the tab it was opened on
// (activeTab); the side panel asks Chrome once for permission to read pages.

export class TabError extends Error {}

export async function currentTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id) {
        throw new TabError('There\'s no tab to read.');
    }
    return tab;
}

const ALL_SITES = {origins: ['<all_urls>']};

// Ask once for permission to read pages (only the side panel needs it). Call
// straight from a click: Chrome only shows the question after one.
export async function ensurePageAccess(): Promise<boolean> {
    if (await chrome.permissions.contains(ALL_SITES)) {
        return true;
    }
    return chrome.permissions.request(ALL_SITES);
}

async function withAccess<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (first) {
        // Not allowed yet (the side panel, or a page opened after the popup).
        if (!(await ensurePageAccess())) {
            throw new TabError('Captain needs your permission to read this page.');
        }
        try {
            return await fn();
        } catch {
            throw restricted(first);
        }
    }
}

function restricted(e: unknown): Error {
    const m = String((e as Error)?.message ?? e);
    if (/chrome:\/\/|chrome-extension|webstore|cannot be scripted|Cannot access/i.test(m)) {
        return new TabError('Chrome doesn\'t let extensions read this kind of page.');
    }
    return e instanceof Error ? e : new Error(m);
}

export async function captureTab(): Promise<Blob> {
    const tab = await currentTab();
    const dataUrl = await withAccess(() => chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'}));
    return (await fetch(dataUrl)).blob();
}

export type PageContent = {title: string; url: string; selection: string; text: string};

// Runs inside the page.
function readPage(): PageContent {
    const selection = String(window.getSelection() ?? '').trim();
    const main = document.querySelector('article, main, [role=main]') as HTMLElement | null;
    const text = ((main ?? document.body)?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return {title: document.title, url: location.href, selection, text: text.slice(0, 60_000)};
}

export async function readTab(): Promise<PageContent> {
    const tab = await currentTab();
    const [result] = await withAccess(() => chrome.scripting.executeScript({target: {tabId: tab.id!}, func: readPage}));
    if (!result?.result) {
        throw new TabError('Couldn\'t read this page.');
    }
    return result.result as PageContent;
}

// Markdown for a link to the page.
export function pageLink(title: string, url: string): string {
    const t = (title || url).replace(/[[\]]/g, '');
    return `[${t}](${url})`;
}

export function quote(text: string): string {
    return text.split('\n').map((l) => `> ${l}`).join('\n');
}

// The page's text as a file agents can read (they read attached .md files).
export function pageFile(p: PageContent): {blob: Blob; name: string} {
    const name = `${(p.title || 'Page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Page'}.md`;
    return {blob: new Blob([`# ${p.title}\n\n${p.url}\n\n${p.text}\n`], {type: 'text/markdown'}), name};
}

export function dataUrlToBlob(dataUrl: string): Promise<Blob> {
    return fetch(dataUrl).then((r) => r.blob());
}
