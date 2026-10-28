// The Mattermost client. All server access goes through @mattermost/client
// (MIT): REST via Client4 and the event stream via WebSocketClient.

import {Client4} from '@mattermost/client';

import {secretDelete, secretGet, secretSet} from './native';

export const client = new Client4();
client.setIncludeCookies(false);

export type Session = {serverUrl: string; token: string; userId: string};

export const DEFAULT_SERVER = (import.meta.env.VITE_MATTERMOST_URL as string | undefined) || 'http://localhost:8065';

export function normalizeServer(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function websocketUrl(serverUrl: string): string {
    return `${serverUrl.replace(/^http/, 'ws')}/api/v4/websocket`;
}

export async function loadSession(): Promise<Session | null> {
    const raw = await secretGet('session');
    if (!raw) {
        return null;
    }
    try {
        const s = JSON.parse(raw) as Session;
        client.setUrl(s.serverUrl);
        client.setToken(s.token);
        return s;
    } catch {
        return null;
    }
}

export async function signIn(serverUrl: string, login: string, password: string): Promise<Session> {
    const url = normalizeServer(serverUrl);
    client.setUrl(url);
    client.setToken('');
    const user = await client.login(login, password);
    const token = client.getToken();
    if (!token) {
        throw new Error('The server did not return a session token.');
    }
    const session = {serverUrl: url, token, userId: user.id};
    await secretSet('session', JSON.stringify(session));
    return session;
}

export async function signOut(): Promise<void> {
    await client.logout().catch(() => undefined);
    await secretDelete('session');
}

// Files and pictures need the session token, which <img src> can't send,
// so fetch them with the header and hand back an object URL.
const blobCache = new Map<string, Promise<string>>();
export function authedObjectUrl(url: string): Promise<string> {
    let p = blobCache.get(url);
    if (!p) {
        p = fetch(url, {headers: {Authorization: `Bearer ${client.getToken()}`}}).
            then((r) => {
                if (!r.ok) {
                    throw new Error(`${r.status}`);
                }
                return r.blob();
            }).
            then((b) => URL.createObjectURL(b));
        p.catch(() => blobCache.delete(url));
        blobCache.set(url, p);
    }
    return p;
}

export function errorMessage(e: unknown): string {
    if (e && typeof e === 'object' && 'message' in e && typeof (e as {message: unknown}).message === 'string') {
        return (e as {message: string}).message;
    }
    return 'Something went wrong. Check your connection and try again.';
}
