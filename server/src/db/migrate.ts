// Numbered SQL migrations (src/db/migrations/0001_name.sql), applied in order
// and recorded in schema_migrations with a checksum. An applied migration is
// never edited: write a new one instead. A lock keeps two servers starting at
// the same time from migrating twice.

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {config} from '../config.js';
import {log} from '../util/log.js';

import type {Sql} from './index.js';

export const MIGRATIONS_DIR = path.join(config.serverDir, 'src', 'db', 'migrations');
const LOCK_KEY = 72_727_272;

type Migration = {version: number; name: string; sql: string; checksum: string};

export function listMigrations(dir = MIGRATIONS_DIR): Migration[] {
    return fs.readdirSync(dir).
        filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).
        sort().
        map((file) => {
            const sql = fs.readFileSync(path.join(dir, file), 'utf8');
            return {version: Number(file.slice(0, 4)), name: file.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex')};
        });
}

export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<number> {
    await sql`create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        checksum text not null,
        applied_at bigint not null
    )`;
    const reserved = await sql.reserve();
    try {
        await reserved`select pg_advisory_lock(${LOCK_KEY})`;
        const applied = new Map((await reserved`select version, checksum from schema_migrations`).map((r) => [Number(r.version), String(r.checksum)]));
        let count = 0;
        for (const m of listMigrations(dir)) {
            const had = applied.get(m.version);
            if (had) {
                if (had !== m.checksum) {
                    throw new Error(`Migration ${m.name} was changed after it was applied. Write a new migration instead.`);
                }
                continue;
            }
            // One transaction per migration, on the connection that holds the lock.
            await reserved.unsafe('begin');
            try {
                await reserved.unsafe(m.sql);
                await reserved`insert into schema_migrations (version, name, checksum, applied_at) values (${m.version}, ${m.name}, ${m.checksum}, ${Date.now()})`;
                await reserved.unsafe('commit');
            } catch (e) {
                await reserved.unsafe('rollback').catch(() => undefined);
                throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
            }
            log.info({migration: m.name}, 'applied migration');
            count++;
        }
        return count;
    } finally {
        await reserved`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined);
        reserved.release();
    }
}
