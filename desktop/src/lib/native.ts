// Everything that needs macOS goes through here. Inside the Tauri app these
// call the Rust core; in a plain browser (development) they fall back to
// something reasonable so the UI can be built and tested without a Mac.

import {invoke} from '@tauri-apps/api/core';
import {emitTo, listen, type UnlistenFn} from '@tauri-apps/api/event';
import {getCurrentWindow, LogicalSize} from '@tauri-apps/api/window';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type PanelMode = 'compose' | 'inbox' | 'thread';
export type PanelTarget = {mode: PanelMode; channelId?: string; postId?: string};

export function windowLabel(): 'main' | 'panel' {
    if (isTauri) {
        return getCurrentWindow().label === 'panel' ? 'panel' : 'main';
    }
    return location.pathname.endsWith('panel.html') ? 'panel' : 'main';
}

// ------------------------------------------------------------ secrets

const LOCAL_PREFIX = 'captain.';

export async function secretGet(key: string): Promise<string | null> {
    if (isTauri) {
        try {
            return await invoke<string | null>('secret_get', {key});
        } catch {
            // fall through to local storage
        }
    }
    return localStorage.getItem(LOCAL_PREFIX + key);
}

export async function secretSet(key: string, value: string): Promise<void> {
    if (isTauri) {
        try {
            await invoke('secret_set', {key, value});
            return;
        } catch {
            // fall through to local storage
        }
    }
    localStorage.setItem(LOCAL_PREFIX + key, value);
}

export async function secretDelete(key: string): Promise<void> {
    if (isTauri) {
        await invoke('secret_delete', {key}).catch(() => undefined);
    }
    localStorage.removeItem(LOCAL_PREFIX + key);
}

// ------------------------------------------------------------ notifications and badge

export async function notify(title: string, body: string, target: PanelTarget): Promise<void> {
    if (isTauri) {
        await invoke('notify', {title, body, target}).catch((e) => console.warn('notify failed', e));
        return;
    }
    if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, {body});
        n.onclick = () => showPanel(target);
    }
}

export async function setBadge(count: number): Promise<void> {
    if (isTauri) {
        await invoke('set_badge', {count}).catch(() => undefined);
        return;
    }
    document.title = count > 0 ? `(${count}) Captain` : 'Captain';
}

// ------------------------------------------------------------ windows

export async function showPanel(target: PanelTarget): Promise<void> {
    if (isTauri) {
        await invoke('show_panel', {target});
        return;
    }
    const q = new URLSearchParams({mode: target.mode, ...(target.channelId ? {channel: target.channelId} : {}), ...(target.postId ? {post: target.postId} : {})});
    window.open(`/panel.html?${q}`, 'captain-panel', 'width=400,height=600');
}

export async function hidePanel(): Promise<void> {
    if (isTauri) {
        await invoke('hide_panel');
    }
}

export async function openDashboard(channelId?: string): Promise<void> {
    if (isTauri) {
        await invoke('open_dashboard');
        if (channelId) {
            await emitTo('main', 'open-channel', channelId);
        }
        return;
    }
    window.open(`/${channelId ? `?channel=${channelId}` : ''}`, 'captain-dashboard');
}

export function onPanelTarget(handler: (t: PanelTarget) => void): () => void {
    if (isTauri) {
        let un: UnlistenFn | undefined;
        listen<PanelTarget>('panel-target', (e) => handler(e.payload)).then((u) => {
            un = u;
        });
        return () => un?.();
    }
    const q = new URLSearchParams(location.search);
    handler({mode: (q.get('mode') as PanelMode) || 'compose', channelId: q.get('channel') || undefined, postId: q.get('post') || undefined});
    return () => undefined;
}

export function onOpenChannel(handler: (channelId: string) => void): () => void {
    if (isTauri) {
        let un: UnlistenFn | undefined;
        listen<string>('open-channel', (e) => handler(e.payload)).then((u) => {
            un = u;
        });
        return () => un?.();
    }
    const c = new URLSearchParams(location.search).get('channel');
    if (c) {
        handler(c);
    }
    return () => undefined;
}

let lastHeight = 0;
export async function setPanelHeight(height: number): Promise<void> {
    const h = Math.max(160, Math.min(680, Math.ceil(height)));
    if (!isTauri || h === lastHeight) {
        return;
    }
    lastHeight = h;
    await getCurrentWindow().setSize(new LogicalSize(400, h)).catch(() => undefined);
}

// ------------------------------------------------------------ events between windows

// The dashboard window owns the one WebSocket and relays each
// event to the panel, so the app keeps a single connection.
export async function relayToPanel(event: unknown): Promise<void> {
    if (isTauri) {
        await emitTo('panel', 'captain-event', event).catch(() => undefined);
    }
}

export function onRelayedEvent(handler: (event: unknown) => void): () => void {
    let un: UnlistenFn | undefined;
    listen('captain-event', (e) => handler(e.payload)).then((u) => {
        un = u;
    });
    return () => un?.();
}

// ------------------------------------------------------------ screen capture

export async function captureScreen(region: boolean): Promise<Blob | null> {
    if (isTauri) {
        const data = await invoke<ArrayBuffer>('capture_screen', {region});
        if (!data || data.byteLength === 0) {
            return null; // cancelled
        }
        return new Blob([data], {type: 'image/png'});
    }
    return browserPreviewCapture();
}

// Without the Mac app there is no screen to capture; draw a labelled
// stand-in so the rest of the flow can be exercised.
async function browserPreviewCapture(): Promise<Blob> {
    const c = document.createElement('canvas');
    c.width = 1440;
    c.height = 900;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 1440, 900);
    grad.addColorStop(0, '#dbe6f7');
    grad.addColorStop(1, '#b8c9e6');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1440, 900);
    g.fillStyle = '#ffffff';
    g.fillRect(160, 120, 1120, 660);
    g.fillStyle = '#0b1640';
    g.fillRect(160, 120, 1120, 56);
    g.fillStyle = '#142769';
    g.font = '600 40px sans-serif';
    g.fillText('Screen snapshot (browser preview)', 220, 300);
    g.fillStyle = '#64718a';
    g.font = '28px sans-serif';
    g.fillText('In the Mac app this is a real capture of your screen.', 220, 360);
    return new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
}

// ------------------------------------------------------------ built-in server

// The Mac app can run the Captain server itself (see src-tauri/src/lib.rs).
export const LOCAL_SERVER = 'http://127.0.0.1:8787';

export type LocalServerStatus = {
    configured: boolean; // has a database address
    running: boolean;
    starting: boolean;
    url: string;
    error: string | null;
    log: string | null; // the end of the server's log, when it stopped
};

export async function localServerStatus(): Promise<LocalServerStatus | null> {
    if (!isTauri) {
        return null;
    }
    return invoke<LocalServerStatus>('local_server_status').catch(() => null);
}

// Accepts a database address, or a whole server .env (its DATABASE_URL and APP_SECRET lines).
export function parseServerSettings(text: string): {databaseUrl: string; appSecret: string | null} {
    const t = text.trim();
    const line = (name: string) => t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') ?? null;
    if (/^DATABASE_URL=/m.test(t)) {
        return {databaseUrl: line('DATABASE_URL') ?? '', appSecret: line('APP_SECRET')};
    }
    return {databaseUrl: t, appSecret: null};
}

export async function localServerSetup(text: string): Promise<void> {
    const {databaseUrl, appSecret} = parseServerSettings(text);
    await invoke('local_server_setup', {databaseUrl, appSecret});
}

export async function localServerRestart(): Promise<void> {
    await invoke('local_server_restart');
}

export async function localServerForget(): Promise<void> {
    await invoke('local_server_forget');
}

// Wait until a server answers its readiness check.
export async function waitForServer(url: string, timeoutMs = 30_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const res = await fetch(`${url}/readyz`, {signal: AbortSignal.timeout(2000)});
            if (res.ok) {
                return true;
            }
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}
