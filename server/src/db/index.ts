// The Postgres connection. Rows come back camelCased and 64-bit integers
// (millisecond timestamps, counters) come back as plain numbers.

import postgres from 'postgres';

import {config} from '../config.js';
import {log} from '../util/log.js';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;
export type Db = Sql | Tx;

export function connect(url = config.databaseUrl, max = config.databasePoolSize): Sql {
    return postgres(url, {
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
