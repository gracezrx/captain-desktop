// Delivers real-time events between server instances through Postgres
// LISTEN/NOTIFY, so scaling out needs no extra infrastructure. Payloads over
// NOTIFY's size limit go through the realtime_outbox table.

import type {Sql} from '../db/index.js';
import type {ServerEvent} from '../shared/types.js';
import {newId, now} from '../util/ids.js';
import {log} from '../util/log.js';

import type {Hub, PublishOptions} from './hub.js';

const CHANNEL = 'captain_events';
const MAX_NOTIFY = 7000;

type Message = {origin: string; userIds?: string[]; event?: ServerEvent; opts?: PublishOptions; outbox?: string};

export class Cluster {
    readonly nodeId = newId();
    private listener: {unlisten: () => Promise<void>} | null = null;
    private cleaner: NodeJS.Timeout | null = null;
    private readonly sql: Sql;

    constructor(sql: Sql) {
        this.sql = sql;
    }

    async start(hub: Hub): Promise<void> {
        this.listener = await this.sql.listen(CHANNEL, (payload) => void this.receive(hub, payload));
        this.cleaner = setInterval(() => {
            this.sql`delete from realtime_outbox where created_at < ${now() - 300_000}`.catch(() => undefined);
        }, 60_000);
    }

    async stop(): Promise<void> {
        if (this.cleaner) {
            clearInterval(this.cleaner);
        }
        await this.listener?.unlisten().catch(() => undefined);
    }

    forward(userIds: string[], event: ServerEvent, opts: PublishOptions): void {
        if (opts.droppable) {
            // Typing and streaming text stay local; the final message is not droppable.
            return;
        }
        const msg: Message = {origin: this.nodeId, userIds, event, opts};
        const text = JSON.stringify(msg);
        const send = async () => {
            if (text.length <= MAX_NOTIFY) {
                await this.sql`select pg_notify(${CHANNEL}, ${text})`;
            } else {
                const id = newId();
                await this.sql`insert into realtime_outbox (id, payload, created_at) values (${id}, ${this.sql.json(msg as never)}, ${now()})`;
                await this.sql`select pg_notify(${CHANNEL}, ${JSON.stringify({origin: this.nodeId, outbox: id})})`;
            }
        };
        send().catch((err) => log.warn({err}, 'cluster forward failed'));
    }

    private async receive(hub: Hub, payload: string): Promise<void> {
        let msg: Message;
        try {
            msg = JSON.parse(payload);
        } catch {
            return;
        }
        if (msg.origin === this.nodeId) {
            return;
        }
        if (msg.outbox) {
            const [row] = await this.sql`select payload from realtime_outbox where id = ${msg.outbox}`;
            if (!row) {
                return;
            }
            msg = row.payload as Message;
        }
        if (msg.userIds && msg.event) {
            hub.deliver(msg.userIds, msg.event, msg.opts);
        }
    }
}
