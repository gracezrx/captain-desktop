import {createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

import {config} from '../config.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: {N: number; r: number; p: number; maxmem: number}) => Promise<Buffer>;
const PARAMS = {N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024};

// Passwords: scrypt with a random salt, stored as "scrypt$N$r$p$salt$hash".
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await scrypt(password.normalize('NFKC'), salt, 32, PARAMS);
    return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [kind, n, r, p, saltB64, hashB64] = stored.split('$');
    if (kind !== 'scrypt' || !hashB64) {
        return false;
    }
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem});
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Session and invite tokens: random, shown once, stored only as a hash.
export function newToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

// Secrets kept in the database (model provider keys): AES-256-GCM with a key
// derived from APP_SECRET. Changing APP_SECRET makes them unreadable.
function secretKey(): Buffer {
    return createHash('sha256').update(`captain:stored-secrets:${config.appSecret}`).digest();
}

export function encryptSecret(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(blob: string): string | null {
    const [v, iv, tag, data] = blob.split(':');
    if (v !== 'v1' || !iv || !tag || !data) {
        return null;
    }
    try {
        const authTag = Buffer.from(tag, 'base64');
        if (authTag.length !== 16) {
            return null;
        }
        const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'), {authTagLength: 16});
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

// Signed, expiring links (file downloads that work in <img src>).
export function sign(value: string, expiresAt: number): string {
    return createHmac('sha256', config.appSecret).update(`${value}.${expiresAt}`).digest('base64url');
}

export function verifySignature(value: string, expiresAt: number, signature: string): boolean {
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
        return false;
    }
    const expected = Buffer.from(sign(value, expiresAt));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
