// The extension's background worker: the right-click menu ("Send to
// Captain") and the toolbar badge (approvals and mentions waiting for you).
// It shares the signed-in session with the popup through chrome.storage.

type StoredSession = {serverUrl: string; token: string; userId: string};

const MENUS: chrome.contextMenus.CreateProperties[] = [
    {id: 'page', title: 'Send this page to Captain', contexts: ['page', 'link']},
    {id: 'selection', title: 'Send “%s” to Captain', contexts: ['selection']},
    {id: 'image', title: 'Send this image to Captain', contexts: ['image']},
    {id: 'screenshot', title: 'Send a screenshot of this tab to Captain', contexts: ['page']},
];

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => MENUS.forEach((m) => chrome.contextMenus.create(m)));
    void chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false});
});

chrome.runtime.onStartup.addListener(() => void updateBadge());

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.windowId) {
        return;
    }
    // First, while Chrome still counts the click: open the side panel.
    void chrome.sidePanel.open({windowId: tab.windowId});
    void (async () => {
        const pending: Record<string, unknown> = {
            nonce: Date.now(),
            kind: String(info.menuItemId),
            url: info.menuItemId === 'page' && info.linkUrl ? info.linkUrl : info.pageUrl ?? tab.url,
            title: info.menuItemId === 'page' && info.linkUrl ? info.linkUrl : tab.title,
            selection: info.selectionText,
            imageUrl: info.srcUrl,
        };
        if (info.menuItemId === 'screenshot') {
            try {
                pending.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
            } catch {
                pending.kind = 'page'; // couldn't capture this page: send its link
            }
        }
        await chrome.storage.session.set({pending});
    })();
});

// ------------------------------------------------------------ badge

chrome.alarms.create('badge', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'badge') {
        void updateBadge();
    }
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['captain.session']) {
        void updateBadge();
    }
});

async function session(): Promise<StoredSession | null> {
    const raw = (await chrome.storage.local.get('captain.session'))['captain.session'];
    try {
        return typeof raw === 'string' ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
        return null;
    }
}

async function get<T>(s: StoredSession, path: string): Promise<T> {
    const res = await fetch(`${s.serverUrl}/api/v1${path}`, {headers: {Authorization: `Bearer ${s.token}`}, signal: AbortSignal.timeout(10_000)});
    if (!res.ok) {
        throw new Error(String(res.status));
    }
    return res.json() as Promise<T>;
}

type Member = {channelId: string; mentionCount: number; msgCount: number};
type Channel = {id: string; type: string; totalMsgCount: number};

// Decisions you can make, plus chats that mention you or DMs you haven't read.
async function updateBadge(): Promise<void> {
    const s = await session();
    if (!s) {
        await chrome.action.setBadgeText({text: ''});
        return;
    }
    try {
        let count = 0;
        const workspaces = await get<{id: string}[]>(s, '/workspaces');
        for (const ws of workspaces.slice(0, 5)) {
            const [approvals, chats] = await Promise.all([
                get<unknown[]>(s, `/workspaces/${ws.id}/approvals`).catch(() => []),
                get<{channels: Channel[]; members: Member[]}>(s, `/workspaces/${ws.id}/channels`),
            ]);
            count += approvals.length;
            const byId = new Map(chats.channels.map((c) => [c.id, c]));
            for (const m of chats.members) {
                const c = byId.get(m.channelId);
                if (m.mentionCount > 0 || (c && (c.type === 'D' || c.type === 'G') && c.totalMsgCount > m.msgCount)) {
                    count++;
                }
            }
        }
        await chrome.action.setBadgeBackgroundColor({color: '#c08a1e'});
        await chrome.action.setBadgeText({text: count > 0 ? String(Math.min(count, 99)) : ''});
    } catch {
        // signed out elsewhere or offline: leave the badge as it was
    }
}
