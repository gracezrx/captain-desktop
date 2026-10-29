// The Postgres connection. Rows come back camelCased and 64-bit integers
// (millisecond timestamps, counters) come back as plain numbers.

import postgres from 'postgres';

import {config} from '../config.js';
import {log} from '../util/log.js';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;
export type Db = Sql | Tx;

// What a connection string needs beyond the defaults. Hosted Postgres
// (Supabase, Neon, Render's external address) requires TLS; Supabase's
// transaction pooler (port 6543) can't hold prepared statements, LISTEN or
// session locks, so its session pooler (port 5432) is the one to use.
export function connectionOptions(url: string): {ssl?: 'require'; prepare?: boolean; warning?: string} {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return {};
    }
    const out: {ssl?: 'require'; prepare?: boolean; warning?: string} = {};
    const mode = (process.env.DATABASE_SSL ?? '').trim().toLowerCase();
    const hosted = /(^|\.)(supabase\.(co|com)|neon\.tech|render\.com)$/.test(u.hostname);
    if (mode === 'require' || (!mode && hosted && !u.searchParams.has('sslmode'))) {
        out.ssl = 'require';
    }
    if (u.port === '6543') {
        out.prepare = false;
        out.warning = 'DATABASE_URL uses port 6543 (Supabase\'s transaction pooler). Real-time updates across instances, saved-key reloads and migration locks need a session connection: use the session pooler address on port 5432 instead.';
    }
    return out;
}

export function connect(url = config.databaseUrl, max = config.databasePoolSize): Sql {
    const {warning, ...extra} = connectionOptions(url);
    if (warning) {
        log.warn(warning);
    }
    return postgres(url, {
        ...extra,
        max,
        idle_timeout: 30,
        connect_timeout: 10,
        transform: postgres.camel,
        types: {
            bigint: {to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x)},
        },
        onnotice: () => undefined,
    }) as unknown as Sql;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

// Run fn in a transaction, retrying when Postgres reports a serialization
// failure or deadlock (the same rule as Mattermost's retry layer).
export async function tx<T>(sql: Sql, fn: (t: Tx) => Promise<T>, attempts = 3): Promise<T> {
    for (let i = 1; ; i++) {
        try {
            return (await sql.begin((t) => fn(t as Tx))) as T;
        } catch (e) {
            const code = (e as {code?: string}).code;
            if (i >= attempts || !code || !RETRYABLE.has(code)) {
                throw e;
            }
            log.warn({code, attempt: i}, 'retrying transaction');
            await new Promise((r) => setTimeout(r, 20 * i + Math.random() * 30));
        }
    }
}
