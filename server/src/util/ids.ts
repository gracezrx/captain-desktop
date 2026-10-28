import {randomBytes} from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// 26-character random IDs, like Mattermost's (about 134 bits of randomness).
export function newId(): string {
    const bytes = randomBytes(26);
    let out = '';
    for (const b of bytes) {
        out += ALPHABET[b % ALPHABET.length];
    }
    return out;
}

export function now(): number {
    return Date.now();
}

export function isId(v: unknown): v is string {
    return typeof v === 'string' && /^[a-z0-9]{26}$/.test(v);
}
