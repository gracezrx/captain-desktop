import type {Sql} from '../db/index.js';
import type {Storage} from '../files/storage.js';
import type {JobQueue} from '../jobs/queue.js';
import type {Router} from '../llm/router.js';
import type {Hub} from '../realtime/hub.js';

import {Hooks} from './hooks.js';

// Everything the app layer needs, passed explicitly (no globals), so tests can
// build an isolated instance against their own database.
export type Ctx = {
    sql: Sql;
    hub: Hub;
    storage: Storage;
    jobs: JobQueue;
    router: Router;
    hooks: Hooks;
};

export function createCtx(parts: Omit<Ctx, 'hooks'>): Ctx {
    return {...parts, hooks: new Hooks()};
}
