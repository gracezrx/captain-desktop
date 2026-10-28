import {api} from './api';
import {useStore} from './store';
import type {ClientPost, Post} from './types';

export type Attachment = {clientId: string; blob: Blob; name: string; previewUrl: string | null};

export function makeAttachment(blob: Blob, name?: string): Attachment {
    const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    return {
        clientId: crypto.randomUUID(),
        blob,
        name: name || `Snapshot ${new Date().toLocaleString(undefined, {hour12: false}).replace(/[/:]/g, '-')}.${ext}`,
        previewUrl: blob.type.startsWith('image/') ? URL.createObjectURL(blob) : null,
    };
}

// Upload any files, then post. The message shows at once and is swapped for
// the server's copy when it comes back (matched by pendingId).
export async function sendMessage(args: {channelId: string; text: string; attachments: Attachment[]; rootId?: string | null}): Promise<Post> {
    const {channelId, text, attachments, rootId = null} = args;
    const store = useStore.getState();
    const me = store.me;
    if (!me || !store.workspace) {
        throw new Error('Not signed in');
    }
    const pendingId = `pending:${crypto.randomUUID()}`;
    const t = Date.now();
    const optimistic: ClientPost = {
        id: pendingId, pendingId, pending: true, channelId, workspaceId: store.workspace.id, userId: me.id, rootId, type: '', message: text,
        props: {}, files: [], createdAt: t, updatedAt: t, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null, reactions: [],
    };
    store.receivePost(optimistic);
    store.rememberChannel(channelId);

    try {
        const files = await Promise.all(attachments.map((a) => api.upload(channelId, a.blob, a.name)));
        const created = await api.createPost(channelId, {message: text, rootId, fileIds: files.map((f) => f.id), pendingId});
        useStore.getState().receivePost(created);
        return created;
    } catch (e) {
        useStore.getState().updatePost({...optimistic, failed: true});
        throw e;
    }
}

// Does this message call on an agent? (used to open its thread right away)
export function mentionsAgent(text: string): boolean {
    const handles = new Set(Object.values(useStore.getState().agents).filter((a) => a.enabled).map((a) => a.handle.toLowerCase()));
    return [...text.matchAll(/(?:^|[^\w@.])@([a-z0-9][a-z0-9._-]*)/gi)].some((m) => handles.has(m[1].toLowerCase()));
}
