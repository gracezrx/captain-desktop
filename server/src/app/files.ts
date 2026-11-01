// Uploads: stored under the workspace, attached to a message when it's sent.
// Downloads use signed, expiring links so they work in <img src>.

import type {Readable} from 'node:stream';

import {config} from '../config.js';
import {imageSize, storageKey} from '../files/storage.js';
import type {FileInfo, FileProps} from '../shared/types.js';
import {getFile, insertFile, type FileRow} from '../store/files.js';
import type {UserRow} from '../store/users.js';
import {verifySignature} from '../util/crypto.js';
import {badRequest, notFound} from '../util/errors.js';
import {newId} from '../util/ids.js';

import type {Ctx} from './context.js';
import {requireChannelMember} from './permissions.js';
import {fileInfo} from './serialize.js';

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|text\/plain|text\/markdown|application\/pdf)$/;

export async function upload(ctx: Ctx, user: UserRow, channelId: string, file: {filename: string; mimetype: string; stream: Readable}): Promise<FileInfo> {
    const {channel} = await requireChannelMember(ctx.sql, channelId, user.id);
    return storeFile(ctx, {workspaceId: channel.workspaceId, channelId, userId: user.id, name: file.filename, mime: file.mimetype, data: file.stream});
}

export async function storeFile(ctx: Ctx, f: {workspaceId: string; channelId: string | null; userId: string; name: string; mime: string; data: Readable | Buffer; props?: FileProps}): Promise<FileInfo> {
    const id = newId();
    const key = storageKey(f.workspaceId, id);
    const name = (f.name || 'file').replace(/[\\/\r\n\0]/g, '_').slice(0, 200);
    let size: number;
    try {
        size = await ctx.storage.put(key, f.data, config.files.maxBytes);
    } catch (e) {
        if ((e as Error).message === 'file too large') {
            throw badRequest(`Files can be up to ${Math.round(config.files.maxBytes / 1024 / 1024)} MB.`, 'file_too_large');
        }
        throw e;
    }
    let dims: {width: number; height: number} | null = null;
    if (f.mime.startsWith('image/')) {
        const head = Buffer.isBuffer(f.data) ? f.data.subarray(0, 65536) : (await ctx.storage.read(key)).subarray(0, 65536);
        dims = imageSize(head);
    }
    const row = await insertFile(ctx.sql, {id, workspaceId: f.workspaceId, channelId: f.channelId, userId: f.userId, name, mime: f.mime || 'application/octet-stream', size, width: dims?.width ?? null, height: dims?.height ?? null, storageKey: key, props: f.props});
    return fileInfo(row);
}

// Serve a file from a signed link (no session needed: the link is the permission).
export async function openSigned(ctx: Ctx, fileId: string, exp: number, sig: string): Promise<{file: FileRow; stream: Readable; inline: boolean}> {
    if (!verifySignature(fileId, exp, sig)) {
        throw notFound('File');
    }
    const file = await getFile(ctx.sql, fileId);
    if (!file) {
        throw notFound('File');
    }
    return {file, stream: ctx.storage.get(file.storageKey), inline: SAFE_INLINE.test(file.mime)};
}

export async function readForAgent(ctx: Ctx, fileId: string): Promise<{file: FileRow; data: Buffer} | null> {
    const file = await getFile(ctx.sql, fileId);
    if (!file) {
        return null;
    }
    return {file, data: await ctx.storage.read(file.storageKey)};
}
