// Server settings for the people who run it (instance admins): the model
// provider keys every workspace on this server shares.

import {z} from 'zod';

import {chatCompletion} from '../llm/client.js';
import {LlmError} from '../llm/types.js';
import type {ProviderCheck, ProviderKeyInfo} from '../shared/types.js';
import {audit} from '../store/audit.js';
import {isInstanceAdmin, type UserRow} from '../store/users.js';
import {badRequest, forbidden, notFound} from '../util/errors.js';

import type {Ctx} from './context.js';

const RECOMMENDED = 'openrouter';

export function requireInstanceAdmin(user: UserRow): void {
    if (!isInstanceAdmin(user)) {
        throw forbidden('Only the people who run this server can change model keys.');
    }
}

function provider(ctx: Ctx, providerId: string) {
    const p = ctx.router.catalog.providers[providerId];
    if (!p) {
        throw notFound('That provider');
    }
    return p;
}

export function listProviders(ctx: Ctx, user: UserRow): ProviderKeyInfo[] {
    requireInstanceAdmin(user);
    const {catalog} = ctx.router;
    const out = Object.entries(catalog.providers).map(([id, p]): ProviderKeyInfo => {
        const stored = ctx.keys.info(id);
        const source = catalog.keySource(id);
        const envKey = (process.env[p.apiKeyEnv] ?? '').trim();
        return {
            id,
            label: p.label,
            recommended: id === RECOMMENDED,
            source,
            last4: source === 'settings' ? stored?.last4 ?? null : source === 'environment' ? envKey.slice(-4) : null,
            unreadable: !!stored && !stored.apiKey,
            needsBaseUrl: !p.baseUrl,
            baseUrl: stored?.baseUrl ?? p.baseUrl ?? (p.baseUrlEnv ? process.env[p.baseUrlEnv] || null : null),
            keysUrl: p.keysUrl ?? null,
            models: catalog.models.filter((m) => m.routes.some(([pid]) => pid === id)).length,
            updatedAt: stored?.updatedAt ?? null,
        };
    });
    // The recommended one first, then the ones in use, then the rest.
    return out.sort((a, b) => Number(b.recommended) - Number(a.recommended) || Number(!!b.source) - Number(!!a.source));
}

const keyInput = z.object({
    apiKey: z.string().trim().min(8, 'That key looks too short.').max(500).regex(/^\S+$/, 'A key has no spaces in it.'),
    baseUrl: z.string().trim().max(500).optional(),
});

// Saving tries the key first. A key the provider turns down isn't saved; any
// other trouble (a slow provider, a model it doesn't carry, no credit) is
// reported but the key is kept, since the key itself may be fine.
export async function saveProviderKey(ctx: Ctx, user: UserRow, providerId: string, body: unknown, ip?: string): Promise<{provider: ProviderKeyInfo; check: ProviderCheck}> {
    requireInstanceAdmin(user);
    const p = provider(ctx, providerId);
    const input = keyInput.parse(body);
    let baseUrl: string | null = null;
    if (!p.baseUrl) {
        // A custom gateway: its address is part of the setting.
        const raw = input.baseUrl || (p.baseUrlEnv ? process.env[p.baseUrlEnv] ?? '' : '');
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            throw badRequest('Enter the gateway\'s address, such as https://gateway.example.com/v1.');
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw badRequest('The gateway\'s address starts with https://.');
        }
        baseUrl = url.toString().replace(/\/+$/, '');
    }
    const check = await probe(ctx, providerId, {baseUrl: baseUrl ?? p.baseUrl!, apiKey: input.apiKey, headers: p.headers});
    if (check.rejected) {
        throw badRequest(`${check.message} It wasn't saved.`, 'key_rejected');
    }
    await ctx.keys.set(providerId, input.apiKey, baseUrl, user.id);
    audit(ctx.sql, {userId: user.id, action: 'provider_key_saved', target: providerId, ip});
    return {provider: listProviders(ctx, user).find((x) => x.id === providerId)!, check: publicCheck(check)};
}

export async function removeProviderKey(ctx: Ctx, user: UserRow, providerId: string, ip?: string): Promise<void> {
    requireInstanceAdmin(user);
    provider(ctx, providerId);
    await ctx.keys.remove(providerId);
    audit(ctx.sql, {userId: user.id, action: 'provider_key_removed', target: providerId, ip});
}

// Try the key in use now.
export async function checkProvider(ctx: Ctx, user: UserRow, providerId: string): Promise<ProviderCheck> {
    requireInstanceAdmin(user);
    const p = provider(ctx, providerId);
    const ep = ctx.router.catalog.endpoint(providerId);
    if (!ep) {
        return {ok: false, message: `No ${p.label} key is set.`};
    }
    return publicCheck(await probe(ctx, providerId, ep));
}

type Probe = ProviderCheck & {rejected?: boolean};

function publicCheck({rejected: _rejected, ...check}: Probe): ProviderCheck {
    return check;
}

// A tiny request to the cheapest models this provider serves.
async function probe(ctx: Ctx, providerId: string, ep: {baseUrl: string; apiKey: string; headers?: Record<string, string>}): Promise<Probe> {
    const p = provider(ctx, providerId);
    const models = ctx.router.catalog.models.
        flatMap((m) => m.routes.filter(([pid]) => pid === providerId).map(([, upstream]) => ({m, upstream}))).
        sort((a, b) => a.m.priceInPerM + a.m.priceOutPerM - (b.m.priceInPerM + b.m.priceOutPerM)).
        slice(0, 3);
    if (!models.length) {
        return {ok: false, message: `No model in the catalog uses ${p.label}. Add one in config/models.json.`};
    }
    let last = '';
    for (const {m, upstream} of models) {
        const started = Date.now();
        try {
            await chatCompletion(
                {baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: upstream, headers: ep.headers},
                {messages: [{role: 'user', content: 'Reply with the word OK.'}], maxTokens: 16, signal: AbortSignal.timeout(20_000)},
            );
            ctx.router.resetProviders([providerId]);
            return {ok: true, message: `It works: ${m.label} answered through ${p.label}.`, modelId: m.id, latencyMs: Date.now() - started};
        } catch (e) {
            const err = e instanceof LlmError ? e : new LlmError((e as Error).message);
            if (err.status === 401 || err.status === 403) {
                return {ok: false, rejected: true, message: `${p.label} turned the key down (${err.status}). Check that you copied all of it and that it's active.`};
            }
            if (err.status === 402) {
                return {ok: false, message: `${p.label} accepted the key but says the account is out of credit. Add credit, then check again.`};
            }
            last = err.message === 'cancelled' ? `${m.label} didn't answer within 20 seconds.` : `${m.label}: ${err.message.slice(0, 200)}`;
        }
    }
    return {ok: false, message: `The test requests failed. ${last}`};
}
