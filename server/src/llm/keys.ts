// Model provider keys pasted in Settings by whoever runs the server. Stored
// encrypted (util/crypto.ts), held in memory for the router, and reloaded on
// every instance when one of them changes (Postgres NOTIFY, plus a slow poll
// in case a notification is missed). A key saved here wins over the same
// provider's environment variable.

import type {Sql} from '../db/index.js';
import {decryptSecret, encryptSecret} from '../util/crypto.js';
import {now} from '../util/ids.js';
import {log} from '../util/log.js';

const CHANNEL = 'captain_keys';
const POLL_MS = 60_000;

export type StoredKey = {
    apiKey: string | null; // null when it can't be decrypted (APP_SECRET changed)
    baseUrl: string | null;
    last4: string;
    updatedAt: number;
    updatedBy: string | null;
};

export class KeyStore {
    private keys = new Map<string, StoredKey>();
    private listener: {unlisten: () => Promise<void>} | null = null;
    private timer: NodeJS.Timeout | null = null;
    private readonly sql: Sql;
    // Called after the keys change, so the router can forget old failures.
    onChange: (providerIds: string[]) => void = () => undefined;

    constructor(sql: Sql) {
        this.sql = sql;
    }

    async load(): Promise<void> {
        const rows = await this.sql`select provider_id, secret, last4, base_url, updated_by, updated_at from provider_keys`;
        const next = new Map<string, StoredKey>();
        for (const r of rows) {
            const apiKey = decryptSecret(String(r.secret));
            if (apiKey === null) {
                log.warn({provider: r.providerId}, 'a saved model key can\'t be decrypted (was APP_SECRET changed?); paste it again in Settings');
            }
            next.set(String(r.providerId), {
                apiKey,
                baseUrl: (r.baseUrl as string | null) ?? null,
                last4: String(r.last4),
                updatedAt: Number(r.updatedAt),
                updatedBy: (r.updatedBy as string | null) ?? null,
            });
        }
        const changed = [...new Set([...this.keys.keys(), ...next.keys()])].filter((id) => {
            const a = this.keys.get(id);
            const b = next.get(id);
            return a?.apiKey !== b?.apiKey || a?.baseUrl !== b?.baseUrl;
        });
        this.keys = next;
        if (changed.length) {
            this.onChange(changed);
        }
    }

    async start(): Promise<void> {
        this.listener = await this.sql.listen(CHANNEL, () => void this.load().catch((err) => log.warn({err}, 'reloading model keys failed')));
        this.timer = setInterval(() => void this.load().catch(() => undefined), POLL_MS);
        this.timer.unref();
    }

    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
        }
        await this.listener?.unlisten().catch(() => undefined);
    }

    // The key and address to use for a provider, or null to fall back to the environment.
    get(providerId: string): {apiKey: string; baseUrl: string | null} | null {
        const k = this.keys.get(providerId);
        return k?.apiKey ? {apiKey: k.apiKey, baseUrl: k.baseUrl} : null;
    }

    info(providerId: string): StoredKey | null {
        return this.keys.get(providerId) ?? null;
    }

    async set(providerId: string, apiKey: string, baseUrl: string | null, userId: string): Promise<void> {
        const t = now();
        const secret = encryptSecret(apiKey);
        const last4 = apiKey.slice(-4);
        await this.sql`
            insert into provider_keys (provider_id, secret, last4, base_url, updated_by, updated_at)
            values (${providerId}, ${secret}, ${last4}, ${baseUrl}, ${userId}, ${t})
            on conflict (provider_id) do update set secret = excluded.secret, last4 = excluded.last4,
                base_url = excluded.base_url, updated_by = excluded.updated_by, updated_at = excluded.updated_at`;
        await this.sql`select pg_notify(${CHANNEL}, ${providerId})`;
        await this.load();
    }

    async remove(providerId: string): Promise<void> {
        await this.sql`delete from provider_keys where provider_id = ${providerId}`;
        await this.sql`select pg_notify(${CHANNEL}, ${providerId})`;
        await this.load();
    }
}
