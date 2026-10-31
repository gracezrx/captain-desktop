// The connected Google apps as agent tools. An agent working for someone
// gets the actions of the apps THAT person connected in this workspace,
// named after the Composio action (gmail_fetch_emails, googledocs_get_document_by_id…)
// with the input schema Composio publishes. Reading runs right away;
// anything that sends or changes something (an email, a calendar event, a
// new doc) waits for that person's approval, like send_email.

import type {Tool} from '../agents/tools/types.js';
import type {Ctx} from '../app/context.js';
import type {UserRow} from '../store/users.js';
import {log} from '../util/log.js';

import {composioUserId, GOOGLE_APPS} from './composio.js';

const MAX_RESULT_CHARS = 20_000;

// A Google Doc comes back as its structure (paragraphs of text runs); the
// text is what an agent needs. Anything else is passed on as compact JSON.
function docText(data: unknown): string | null {
    const runs: string[] = [];
    let title = '';
    const walk = (v: unknown, depth: number) => {
        if (!v || typeof v !== 'object' || depth > 40) {
            return;
        }
        if (Array.isArray(v)) {
            v.forEach((x) => walk(x, depth + 1));
            return;
        }
        const o = v as Record<string, unknown>;
        if (!title && typeof o.title === 'string' && 'body' in o) {
            title = o.title;
        }
        const run = o.textRun as {content?: unknown} | undefined;
        if (run && typeof run.content === 'string') {
            runs.push(run.content);
        }
        for (const x of Object.values(o)) {
            walk(x, depth + 1);
        }
    };
    walk(data, 0);
    const text = runs.join('');
    return text.trim().length > 40 ? `${title ? `# ${title}\n\n` : ''}${text}` : null;
}

export function readable(data: unknown): string {
    const text = docText(data) ?? (typeof data === 'string' ? data : JSON.stringify(data));
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[cut short]` : text;
}

function words(slug: string): string {
    return slug.split('_').slice(1).join(' ').toLowerCase();
}

export async function connectorTools(ctx: Ctx, requester: UserRow, workspaceId: string): Promise<Tool[]> {
    if (!ctx.composio.configured() || requester.isBot) {
        return [];
    }
    const userId = composioUserId(requester.id, workspaceId);
    let connected: Map<string, string>;
    try {
        connected = new Map((await ctx.composio.connections(userId)).filter((c) => c.status === 'ACTIVE').map((c) => [c.toolkit, c.id]));
    } catch (err) {
        log.warn({err: (err as Error).message}, 'couldn\'t list Google connections; going on without them');
        return [];
    }
    const wanted = GOOGLE_APPS.filter((a) => connected.has(a.toolkit)).flatMap((app) => [
        ...app.read.map((slug) => ({app, slug, writes: false})),
        ...app.write.map((slug) => ({app, slug, writes: true})),
    ]);
    const schemas = await Promise.all(wanted.map((w) => ctx.composio.schema(w.slug).catch(() => null)));
    const tools: Tool[] = [];
    wanted.forEach(({app, slug, writes}, i) => {
        const schema = schemas[i];
        if (!schema) {
            return;
        }
        const accountId = connected.get(app.toolkit)!;
        tools.push({
            name: slug.toLowerCase(),
            description: `${app.name}, ${requester.displayName}'s account: ${schema.description}`.slice(0, 1000),
            parameters: schema.parameters,
            external: writes,
            available: () => true,
            activity: () => (writes ? `Getting ${app.name} ready` : `Looking in ${app.name}`),
            describe: (args) => ({
                title: `${app.name}: ${words(slug)}`,
                reason: `This uses ${requester.displayName}'s ${app.name} and sends or changes something there.`,
                fields: Object.entries(args).slice(0, 8).map(([label, v]) => ({label, value: (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 2000)})),
            }),
            async run(_tc, args) {
                const res = await ctx.composio.execute(slug, userId, accountId, args);
                if (!res.ok) {
                    return {content: `${app.name} didn't do that: ${res.error ?? 'no reason given'}`};
                }
                return {content: readable(res.data)};
            },
        });
    });
    return tools;
}
