// A durable job queue on Postgres. Workers claim jobs with
// FOR UPDATE SKIP LOCKED and hold a lease they keep extending while working;
// if a server dies mid-job, the lease runs out and another worker takes the
// job again. Enqueueing inside a transaction makes the job appear only if
// the transaction commits. NOTIFY wakes idle workers immediately.

import os from 'node:os';

import type {Db, Sql} from '../db/index.js';
import {newId, now} from '../util/ids.js';
import {log} from '../util/log.js';

export type JobContext = {jobId: string; attempt: number; signal: AbortSignal};
export type JobHandler<P = Record<string, unknown>> = (payload: P, ctx: JobContext) => Promise<void>;
type Registration = {handler: JobHandler<never>; maxAttempts: number; onFailed?: (payload: never, error: string) => Promise<void>};

const CHANNEL = 'captain_jobs';

export class JobQueue {
    private handlers = new Map<string, Registration>();
    private active = new Map<string, AbortController>();
    private timer: NodeJS.Timeout | null = null;
    private stopping = false;
    private polling = false;
    private listener: {unlisten: () => Promise<void>} | null = null;
    readonly workerId = `${os.hostname()}:${process.pid}:${newId().slice(0, 6)}`;
    private readonly sql: Sql;
    private readonly concurrency: number;
    private readonly leaseMs: number;

    constructor(sql: Sql, opts: {concurrency: number; leaseSeconds: number}) {
        this.sql = sql;
        this.concurrency = opts.concurrency;
        this.leaseMs = opts.leaseSeconds * 1000;
    }

    register<P>(kind: string, handler: JobHandler<P>, opts: {maxAttempts?: number; onFailed?: (payload: P, error: string) => Promise<void>} = {}): void {
        this.handlers.set(kind, {handler: handler as JobHandler<never>, maxAttempts: opts.maxAttempts ?? 3, onFailed: opts.onFailed as Registration['onFailed']});
    }

    async enqueue(db: Db, kind: string, payload: Record<string, unknown>, opts: {delayMs?: number; dedupeKey?: string; maxAttempts?: number} = {}): Promise<void> {
        const t = now();
        await db`
            insert into jobs (id, kind, payload, status, run_at, max_attempts, dedupe_key, created_at, updated_at)
            values (${newId()}, ${kind}, ${db.json(payload as never)}, 'queued', ${t + (opts.delayMs ?? 0)}, ${opts.maxAttempts ?? this.handlers.get(kind)?.maxAttempts ?? 3}, ${opts.dedupeKey ?? null}, ${t}, ${t})
            on conflict (dedupe_key) where dedupe_key is not null and status = 'queued' do nothing`;
        await db`select pg_notify(${CHANNEL}, ${kind})`;
    }

    async start(): Promise<void> {
        this.stopping = false;
        this.listener = await this.sql.listen(CHANNEL, () => void this.poll());
        this.timer = setInterval(() => void this.poll(), 1000);
        void this.poll();
        log.info({worker: this.workerId, concurrency: this.concurrency}, 'job workers started');
    }

    async stop(timeoutMs = 10_000): Promise<void> {
        this.stopping = true;
        if (this.timer) {
            clearInterval(this.timer);
        }
        await this.listener?.unlisten().catch(() => undefined);
        const deadline = Date.now() + timeoutMs;
        while (this.active.size && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        // Anything still running gets its lease released so another server picks it up.
        for (const [id, ctrl] of this.active) {
            ctrl.abort();
            await this.sql`update jobs set status = 'queued', locked_by = null, locked_until = null where id = ${id} and status = 'running'`.catch(() => undefined);
        }
    }

    private async poll(): Promise<void> {
        if (this.polling || this.stopping) {
            return;
        }
        this.polling = true;
        try {
            const free = this.concurrency - this.active.size;
            if (free <= 0) {
                return;
            }
            const t = now();
            const kinds = [...this.handlers.keys()];
            const jobs = await this.sql`
                update jobs set status = 'running', locked_by = ${this.workerId}, locked_until = ${t + this.leaseMs}, attempts = attempts + 1, updated_at = ${t}
                where id in (
                    select id from jobs
                    where kind = any(${kinds}) and ((status = 'queued' and run_at <= ${t}) or (status = 'running' and locked_until < ${t}))
                    order by run_at limit ${free}
                    for update skip locked)
                returning id, kind, payload, attempts, max_attempts`;
            for (const job of jobs) {
                void this.execute(job.id as string, job.kind as string, job.payload as Record<string, unknown>, Number(job.attempts), Number(job.maxAttempts));
            }
        } catch (e) {
            if (!this.stopping) {
                log.error({err: e}, 'job poll failed');
            }
        } finally {
            this.polling = false;
        }
    }

    private async execute(id: string, kind: string, payload: Record<string, unknown>, attempt: number, maxAttempts: number): Promise<void> {
        const reg = this.handlers.get(kind);
        const ctrl = new AbortController();
        this.active.set(id, ctrl);
        const heartbeat = setInterval(() => {
            this.sql`update jobs set locked_until = ${now() + this.leaseMs} where id = ${id} and locked_by = ${this.workerId}`.catch(() => undefined);
        }, Math.max(1000, this.leaseMs / 3));
        const started = Date.now();
        try {
            if (!reg) {
                throw new Error(`no handler for job kind ${kind}`);
            }
            await reg.handler(payload as never, {jobId: id, attempt, signal: ctrl.signal});
            await this.sql`update jobs set status = 'done', locked_by = null, locked_until = null, updated_at = ${now()} where id = ${id} and locked_by = ${this.workerId}`;
            log.debug({job: kind, id, ms: Date.now() - started}, 'job done');
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const final = attempt >= maxAttempts;
            log.warn({job: kind, id, attempt, final, err: message}, 'job failed');
            await this.sql`
                update jobs set status = ${final ? 'failed' : 'queued'}, last_error = ${message.slice(0, 2000)},
                    run_at = ${now() + Math.min(60_000, 2000 * 2 ** (attempt - 1))}, locked_by = null, locked_until = null, updated_at = ${now()}
                where id = ${id} and locked_by = ${this.workerId}`.catch(() => undefined);
            if (final && reg?.onFailed) {
                await reg.onFailed(payload as never, message).catch((err) => log.error({err}, 'onFailed handler threw'));
            }
        } finally {
            clearInterval(heartbeat);
            this.active.delete(id);
            if (!this.stopping) {
                setImmediate(() => void this.poll());
            }
        }
    }

    async cleanup(): Promise<void> {
        await this.sql`delete from jobs where status in ('done', 'failed') and updated_at < ${now() - 7 * 86_400_000}`;
    }
}
