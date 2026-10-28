// The durable job queue: retries with backoff, dedupe, and recovery of jobs
// whose worker died (an expired lease).

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {connect, type Sql} from '../src/db/index.js';
import {migrate} from '../src/db/migrate.js';
import {JobQueue} from '../src/jobs/queue.js';
import {now} from '../src/util/ids.js';

import {resetDatabase, TEST_DB, waitFor} from './helpers.js';

describe('job queue', () => {
    let sql: Sql;
    const queues: JobQueue[] = [];
    before(async () => {
        await resetDatabase();
        sql = connect(TEST_DB, 4);
        await migrate(sql);
    });
    after(async () => {
        for (const q of queues) {
            await q.stop(1000);
        }
        await sql.end();
    });

    const queue = () => {
        const q = new JobQueue(sql, {concurrency: 2, leaseSeconds: 2});
        queues.push(q);
        return q;
    };

    it('runs jobs, retries failures, and reports the final failure', async () => {
        const q = queue();
        const seen: number[] = [];
        let failedWith = '';
        q.register<{n: number}>('flaky', async (p, ctx) => {
            seen.push(ctx.attempt);
            if (p.n === 1) {
                throw new Error('always fails');
            }
            if (ctx.attempt < 2) {
                throw new Error('first try fails');
            }
        }, {maxAttempts: 2, onFailed: async (_p, e) => {
            failedWith = e;
        }});
        await q.start();
        await q.enqueue(sql, 'flaky', {n: 0});
        await q.enqueue(sql, 'flaky', {n: 1});
        await waitFor(async () => failedWith && (await sql`select count(*)::int as c from jobs where status = 'done'`)[0].c === 1, 15_000, 'jobs to settle');
        assert.equal(failedWith, 'always fails');
        assert.equal(seen.length, 4);
    });

    it('keeps one queued job per dedupe key', async () => {
        const q = queue();
        q.register('noop', async () => undefined);
        await q.enqueue(sql, 'noop', {}, {dedupeKey: 'same', delayMs: 60_000});
        await q.enqueue(sql, 'noop', {}, {dedupeKey: 'same', delayMs: 60_000});
        const [{c}] = await sql`select count(*)::int as c from jobs where dedupe_key = 'same'`;
        assert.equal(c, 1);
    });

    it('picks up a job whose worker stopped heart-beating', async () => {
        const q = queue();
        let ran = false;
        q.register('orphan', async () => {
            ran = true;
        });
        // A job claimed by a worker that died a while ago.
        await sql`insert into jobs (id, kind, payload, status, run_at, attempts, max_attempts, locked_by, locked_until, created_at, updated_at)
                  values ('orphanjob00000000000000000', 'orphan', '{}'::jsonb, 'running', ${now() - 10_000}, 1, 3, 'dead-worker', ${now() - 1000}, ${now()}, ${now()})`;
        await q.start();
        await waitFor(async () => ran, 10_000, 'orphan job');
        const [job] = await sql`select status, locked_by from jobs where id = 'orphanjob00000000000000000'`;
        await waitFor(async () => (await sql`select status from jobs where id = 'orphanjob00000000000000000'`)[0].status === 'done', 5000, 'done');
        assert.ok(job);
    });
});
