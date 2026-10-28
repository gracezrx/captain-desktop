import type {Post} from '@mattermost/types/posts';

import {client} from './mm';
import {useStore} from './store';

export type Attachment = {clientId: string; blob: Blob; name: string; previewUrl: string};

export function makeAttachment(blob: Blob, name?: string): Attachment {
    const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    return {
        clientId: crypto.randomUUID(),
        blob,
        name: name || `Snapshot ${new Date().toLocaleString(undefined, {hour12: false}).replace(/[/:]/g, '-')}.${ext}`,
        previewUrl: URL.createObjectURL(blob),
    };
}

// Upload any files, then post. The message shows immediately and is swapped
// for the server's copy when it comes back (matched by pending_post_id).
export async function sendMessage(args: {channelId: string; text: string; attachments: Attachment[]; rootId?: string}): Promise<Post> {
    const {channelId, text, attachments, rootId = ''} = args;
    const store = useStore.getState();
    const me = store.me;
    if (!me) {
        throw new Error('Not signed in');
    }
    const pendingId = `${me.id}:${Date.now()}`;
    const optimistic = {
        id: pendingId, pending_post_id: pendingId, create_at: Date.now(), update_at: Date.now(), edit_at: 0, delete_at: 0,
        is_pinned: false, user_id: me.id, channel_id: channelId, root_id: rootId, original_id: '', message: text,
        type: '', props: {}, hashtags: '', reply_count: 0, file_ids: [], metadata: {},
    } as unknown as Post;
    store.receivePost(optimistic);
    store.rememberChannel(channelId);

    try {
        let fileIds: string[] = [];
        if (attachments.length) {
            const form = new FormData();
            form.append('channel_id', channelId);
            for (const a of attachments) {
                form.append('client_ids', a.clientId);
                form.append('files', a.blob, a.name);
            }
            const uploaded = await client.uploadFile(form);
            fileIds = uploaded.file_infos.map((f) => f.id);
        }
        const created = await client.createPost({channel_id: channelId, message: text, root_id: rootId, file_ids: fileIds, pending_post_id: pendingId} as Post);
        useStore.getState().receivePost(created);
        return created;
    } catch (e) {
        useStore.getState().updatePost({...optimistic, failed: true});
        throw e;
    }
}
