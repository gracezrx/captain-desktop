// A minimal Mattermost client for one bot: REST with its token, plus the
// WebSocket event stream with automatic reconnect.

import WebSocket from 'ws';

import {config} from './config.ts';

export type Post = {
    id: string;
    create_at: number;
    user_id: string;
    channel_id: string;
    root_id: string;
    message: string;
    type: string;
    props: Record<string, unknown>;
    file_ids?: string[];
    metadata?: {files?: {id: string; mime_type: string; name: string}[]};
};

export type User = {id: string; username: string; first_name: string; last_name: string; is_bot?: boolean};
export type Channel = {id: string; type: string; name: string; display_name: string; team_id: string};

export class Bot {
    readonly token: string;
    me!: User;

    constructor(token: string) {
        this.token = token;
    }

    async api<T>(path: string, init: RequestInit = {}): Promise<T> {
        const res = await fetch(`${config.mattermostUrl}/api/v4${path}`, {
            ...init,
            headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(init.headers ?? {})},
        });
        if (!res.ok) {
            throw new Error(`Mattermost ${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
        }
        return res.json() as Promise<T>;
    }

    async init(): Promise<void> {
        this.me = await this.api<User>('/users/me');
    }

    getUser(id: string) {
        return this.api<User>(`/users/${id}`);
    }

    getChannel(id: string) {
        return this.api<Channel>(`/channels/${id}`);
    }

    async thread(rootId: string): Promise<Post[]> {
        const list = await this.api<{order: string[]; posts: Record<string, Post>}>(`/posts/${rootId}/thread`);
        return Object.values(list.posts).sort((a, b) => a.create_at - b.create_at);
    }

    async recent(channelId: string, count = 20): Promise<Post[]> {
        const list = await this.api<{order: string[]; posts: Record<string, Post>}>(`/channels/${channelId}/posts?per_page=${count}`);
        return Object.values(list.posts).sort((a, b) => a.create_at - b.create_at);
    }

    post(body: Partial<Post> & {channel_id: string; message: string}) {
        return this.api<Post>('/posts', {method: 'POST', body: JSON.stringify(body)});
    }

    async file(id: string): Promise<{data: Buffer; type: string}> {
        const res = await fetch(`${config.mattermostUrl}/api/v4/files/${id}`, {headers: {Authorization: `Bearer ${this.token}`}});
        if (!res.ok) {
            throw new Error(`file ${id}: ${res.status}`);
        }
        return {data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'application/octet-stream'};
    }

    // ---------------------------------------------------------- events

    private ws: WebSocket | null = null;
    private seq = 1;
    private retry = 0;

    listen(onEvent: (event: {event: string; data: Record<string, unknown>; broadcast: Record<string, unknown>}) => void): void {
        const url = `${config.mattermostUrl.replace(/^http/, 'ws')}/api/v4/websocket`;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.on('open', () => {
            this.retry = 0;
            ws.send(JSON.stringify({seq: this.seq++, action: 'authentication_challenge', data: {token: this.token}}));
        });
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.event) {
                    onEvent(msg);
                }
            } catch {
                // ignore malformed frames
            }
        });
        const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({seq: this.seq++, action: 'ping'})), 30000);
        ws.on('close', () => {
            clearInterval(ping);
            const wait = Math.min(30000, 1000 * 2 ** this.retry++);
            console.warn(`[${this.me?.username}] connection closed, reconnecting in ${wait / 1000}s`);
            setTimeout(() => this.listen(onEvent), wait);
        });
        ws.on('error', (e) => console.warn(`[${this.me?.username}] websocket error: ${e.message}`));
    }

    typing(channelId: string, parentId = ''): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({seq: this.seq++, action: 'user_typing', data: {channel_id: channelId, parent_id: parentId}}));
        }
    }
}

export function nameOf(u: User | undefined): string {
    if (!u) {
        return 'Someone';
    }
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username;
}
