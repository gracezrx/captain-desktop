import type {McpToolInfo} from '../connectors/mcp/client.js';
import type {OAuthMeta} from '../connectors/mcp/oauth.js';
import type {Db} from '../db/index.js';
import {notFound} from '../util/errors.js';
import {newId, now} from '../util/ids.js';

export type McpStatus = 'connected' | 'needs_sign_in' | 'error' | 'unverified';

// Sign-in details kept with a connection. Secrets in it are encrypted.
export type McpOAuthState = {
    meta?: OAuthMeta;
    client?: {clientId: string; clientSecret: string | null; redirectUri: string; issuer: string};
    expiresAt?: number | null;
    // A sign-in under way: `ticket` (hashed) opens Captain's start page once;
    // `browser` (hashed) is the cookie that page gives the browser, which the
    // callback must bring back; `authorize` is the sign-in server's page.
    pending?: {nonce: string; verifier: string; expiresAt: number; ticket?: string | null; browser?: string | null; authorize?: string};
};

export type McpRow = {
    id: string;
    workspaceId: string;
    userId: string;
    preset: string | null;
    name: string;
    url: string;
    authMode: 'none' | 'token' | 'oauth';
    authHeader: string | null;
    token: string | null; // encrypted
    refreshToken: string | null; // encrypted
    oauth: McpOAuthState;
    status: McpStatus;
    lastError: string | null;
    tools: McpToolInfo[];
    enabled: boolean;
    verifiedAt: number | null;
    createdAt: number;
    updatedAt: number;
};

export async function insertMcp(db: Db, r: Pick<McpRow, 'workspaceId' | 'userId' | 'preset' | 'name' | 'url' | 'authMode' | 'authHeader' | 'token'>): Promise<McpRow> {
    const t = now();
    const [row] = await db`
        insert into mcp_connections (id, workspace_id, user_id, preset, name, url, auth_mode, auth_header, token, created_at, updated_at)
        values (${newId()}, ${r.workspaceId}, ${r.userId}, ${r.preset}, ${r.name}, ${r.url}, ${r.authMode}, ${r.authHeader}, ${r.token}, ${t}, ${t})
        returning *`;
    return row as unknown as McpRow;
}

export async function getMcp(db: Db, id: string): Promise<McpRow | null> {
    const [row] = await db`select * from mcp_connections where id = ${id}`;
    return (row as unknown as McpRow) ?? null;
}

export async function listMcp(db: Db, workspaceId: string, userId: string): Promise<McpRow[]> {
    return (await db`select * from mcp_connections where workspace_id = ${workspaceId} and user_id = ${userId} order by created_at`) as unknown as McpRow[];
}

type Patch = Partial<Pick<McpRow, 'authMode' | 'authHeader' | 'token' | 'refreshToken' | 'oauth' | 'status' | 'lastError' | 'tools' | 'enabled' | 'verifiedAt' | 'name'>>;

export async function updateMcp(db: Db, id: string, p: Patch): Promise<McpRow> {
    const [row] = await db`
        update mcp_connections set
            auth_mode = coalesce(${p.authMode ?? null}, auth_mode),
            auth_header = case when ${p.authHeader !== undefined} then ${p.authHeader ?? null} else auth_header end,
            token = case when ${p.token !== undefined} then ${p.token ?? null} else token end,
            refresh_token = case when ${p.refreshToken !== undefined} then ${p.refreshToken ?? null} else refresh_token end,
            oauth = case when ${p.oauth !== undefined} then ${db.json((p.oauth ?? {}) as never)} else oauth end,
            status = coalesce(${p.status ?? null}, status),
            last_error = case when ${p.lastError !== undefined} then ${p.lastError ?? null} else last_error end,
            tools = case when ${p.tools !== undefined} then ${db.json((p.tools ?? []) as never)} else tools end,
            enabled = coalesce(${p.enabled ?? null}, enabled),
            verified_at = case when ${p.verifiedAt !== undefined} then ${p.verifiedAt ?? null} else verified_at end,
            name = coalesce(${p.name ?? null}, name),
            updated_at = ${now()}
        where id = ${id} returning *`;
    if (!row) {
        throw notFound('That connection'); // removed meanwhile
    }
    return row as unknown as McpRow;
}

// Take the pending sign-in off a connection, once: a second callback with
// the same code finds nothing to take.
export async function takePending(db: Db, id: string, nonce: string): Promise<{row: McpRow; pending: NonNullable<McpOAuthState['pending']>} | null> {
    const [row] = await db`
        with old as (
            select oauth->'pending' as pending from mcp_connections
            where id = ${id} and oauth->'pending'->>'nonce' = ${nonce} for update
        )
        update mcp_connections m set oauth = m.oauth - 'pending', updated_at = ${now()}
        from old where m.id = ${id}
        returning m.*, old.pending as taken`;
    if (!row) {
        return null;
    }
    const {taken, ...rest} = row as unknown as McpRow & {taken: NonNullable<McpOAuthState['pending']>};
    return {row: rest as McpRow, pending: taken};
}

// A connection by its sign-in start ticket (hashed).
export async function byTicket(db: Db, ticketHash: string): Promise<McpRow | null> {
    const [row] = await db`select * from mcp_connections where oauth->'pending'->>'ticket' = ${ticketHash}`;
    return (row as unknown as McpRow) ?? null;
}

// Use the ticket (once) and remember the browser it was used in.
export async function claimTicket(db: Db, id: string, ticketHash: string, browserHash: string): Promise<boolean> {
    const rows = await db`
        update mcp_connections
        set oauth = jsonb_set(jsonb_set(oauth, '{pending,ticket}', 'null'::jsonb), '{pending,browser}', to_jsonb(${browserHash}::text)), updated_at = ${now()}
        where id = ${id} and oauth->'pending'->>'ticket' = ${ticketHash} returning 1`;
    return rows.length > 0;
}

export async function deleteMcp(db: Db, id: string): Promise<void> {
    await db`delete from mcp_connections where id = ${id}`;
}
