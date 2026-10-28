import type {Db} from '../db/index.js';
import type {Agent, Tier} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type AgentRow = Agent & {createdAt: number; updatedAt: number};

export function toAgent(r: AgentRow): Agent {
    const {createdAt: _c, updatedAt: _u, ...a} = r;
    return a;
}

export async function insertAgent(db: Db, a: Omit<Agent, 'id'> & {id?: string}): Promise<AgentRow> {
    const t = now();
    const [row] = await db`
        insert into agents (id, workspace_id, user_id, handle, name, description, instructions, tier, model, tools, portrait, is_coordinator, enabled, builtin, created_at, updated_at)
        values (${a.id ?? newId()}, ${a.workspaceId}, ${a.userId}, ${a.handle}, ${a.name}, ${a.description}, ${a.instructions}, ${a.tier}, ${a.model},
                ${a.tools}, ${a.portrait}, ${a.isCoordinator}, ${a.enabled}, ${a.builtin}, ${t}, ${t})
        returning *`;
    return row as unknown as AgentRow;
}

export async function listAgents(db: Db, workspaceId: string): Promise<AgentRow[]> {
    return (await db`select * from agents where workspace_id = ${workspaceId} order by is_coordinator desc, builtin desc, name`) as unknown as AgentRow[];
}

export async function getAgent(db: Db, id: string): Promise<AgentRow | null> {
    const [row] = await db`select * from agents where id = ${id}`;
    return (row as unknown as AgentRow) ?? null;
}

export async function getAgentByUserId(db: Db, userId: string): Promise<AgentRow | null> {
    const [row] = await db`select * from agents where user_id = ${userId}`;
    return (row as unknown as AgentRow) ?? null;
}

export async function getAgentsByUserIds(db: Db, userIds: string[]): Promise<AgentRow[]> {
    if (!userIds.length) {
        return [];
    }
    return (await db`select * from agents where user_id = any(${userIds})`) as unknown as AgentRow[];
}

export async function updateAgent(db: Db, id: string, patch: Partial<{name: string; description: string; instructions: string; tier: Tier | 'auto'; model: string | null; tools: string[]; portrait: string; enabled: boolean}>): Promise<AgentRow> {
    const [row] = await db`
        update agents set
            name = coalesce(${patch.name ?? null}, name),
            description = coalesce(${patch.description ?? null}, description),
            instructions = coalesce(${patch.instructions ?? null}, instructions),
            tier = coalesce(${patch.tier ?? null}, tier),
            model = case when ${patch.model !== undefined} then ${patch.model ?? null} else model end,
            tools = coalesce(${patch.tools ?? null}, tools),
            portrait = coalesce(${patch.portrait ?? null}, portrait),
            enabled = coalesce(${patch.enabled ?? null}, enabled),
            updated_at = ${now()}
        where id = ${id}
        returning *`;
    return row as unknown as AgentRow;
}
