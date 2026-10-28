// File storage on local disk (a persistent volume in production). Keys are
// "<workspace>/<yyyy-mm>/<file id>". The interface is small so an S3 backend
// can slot in later.

import {createReadStream, createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export interface Storage {
    put(key: string, data: Readable | Buffer, maxBytes: number): Promise<number>;
    get(key: string): Readable;
    read(key: string): Promise<Buffer>;
    remove(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
    private readonly root: string;

    constructor(root: string) {
        this.root = root;
    }

    private file(key: string): string {
        const full = path.resolve(this.root, key);
        if (!full.startsWith(path.resolve(this.root) + path.sep)) {
            throw new Error('invalid storage key');
        }
        return full;
    }

    async put(key: string, data: Readable | Buffer, maxBytes: number): Promise<number> {
        const target = this.file(key);
        await fs.mkdir(path.dirname(target), {recursive: true});
        if (Buffer.isBuffer(data)) {
            if (data.length > maxBytes) {
                throw new Error('file too large');
            }
            await fs.writeFile(target, data);
            return data.length;
        }
        let size = 0;
        const out = createWriteStream(target);
        try {
            await pipeline(data, async function* (src) {
                for await (const chunk of src) {
                    size += (chunk as Buffer).length;
                    if (size > maxBytes) {
                        throw new Error('file too large');
                    }
                    yield chunk;
                }
            }, out);
        } catch (e) {
            await fs.rm(target, {force: true});
            throw e;
        }
        return size;
    }

    get(key: string): Readable {
        return createReadStream(this.file(key));
    }

    read(key: string): Promise<Buffer> {
        return fs.readFile(this.file(key));
    }

    async remove(key: string): Promise<void> {
        await fs.rm(this.file(key), {force: true});
    }
}

// Width and height from the first bytes of a PNG, JPEG, GIF or WebP.
export function imageSize(head: Buffer): {width: number; height: number} | null {
    if (head.length > 24 && head.readUInt32BE(0) === 0x89504e47) {
        return {width: head.readUInt32BE(16), height: head.readUInt32BE(20)};
    }
    if (head.length > 10 && head.toString('ascii', 0, 3) === 'GIF') {
        return {width: head.readUInt16LE(6), height: head.readUInt16LE(8)};
    }
    if (head.length > 30 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
        const kind = head.toString('ascii', 12, 16);
        if (kind === 'VP8X') {
            return {width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3)};
        }
        if (kind === 'VP8 ') {
            return {width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff};
        }
        if (kind === 'VP8L') {
            const b = head.readUInt32LE(21);
            return {width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff)};
        }
    }
    if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
        let i = 2;
        while (i + 9 < head.length) {
            if (head[i] !== 0xff) {
                i++;
                continue;
            }
            const marker = head[i + 1];
            const len = head.readUInt16BE(i + 2);
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return {height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7)};
            }
            i += 2 + len;
        }
    }
    return null;
}

export function storageKey(workspaceId: string, fileId: string, t = Date.now()): string {
    const d = new Date(t);
    return `${workspaceId}/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}/${fileId}`;
}
