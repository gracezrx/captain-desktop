import type {Db} from '../db/index.js';
import {newId, now} from '../util/ids.js';
import {log} from '../util/log.js';

// An append-only record of security-relevant actions (sign-ins, role changes,
// invites, approvals). Never blocks the action it records.
export function audit(db: Db, e: {workspaceId?: string | null; userId?: string | null; action: string; target?: string | null; meta?: Record<string, unknown>; ip?: string | null}): void {
    db`insert into audit_log (id, workspace_id, user_id, action, target, meta, ip, created_at)
       values (${newId()}, ${e.workspaceId ?? null}, ${e.userId ?? null}, ${e.action}, ${e.target ?? null}, ${db.json((e.meta ?? {}) as never)}, ${e.ip ?? null}, ${now()})`.
        catch((err) => log.warn({err, action: e.action}, 'audit write failed'));
}
